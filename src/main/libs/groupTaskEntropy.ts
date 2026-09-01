import { truncateUtf16Units, truncateUtf16UnitsFromEnd } from './llmSafeText';

/**
 * Group-task entropy P0 helpers — deterministic cuts at the biggest waste
 * taps found by the thermodynamic audit:
 *
 *  1. floorGate  — ceremony-shaped worker lines ([WORKING]/[STANDBY] ACKs)
 *                  no longer trigger a chair floor-control LLM turn that
 *                  would end [NO_REPLY] after burning the tokens.
 *  2. ackTemplate — the worker auto-ACK is a template by default (zero LLM);
 *                  the LLM phrasing stays available as an opt-in enhancement.
 *  3. logFold    — the 20-message group log window truncates each message
 *                  (head+tail) and folds runs of ceremony lines, so the same
 *                  token is not re-paid as recurring input heat every turn.
 *
 * All three ride one kv switch (cowork_config key `groupTaskEntropyP0`) with
 * independent booleans, defaulting to enabled — a bad interaction can be
 * rolled back per knob without a release.
 */

export interface GroupTaskEntropyP0Config {
  floorGate: boolean;
  ackTemplate: boolean;
  logFold: boolean;
}

export const DEFAULT_GROUP_TASK_ENTROPY_P0: GroupTaskEntropyP0Config = {
  floorGate: true,
  ackTemplate: true,
  logFold: true,
};

/** Parse the persisted JSON knob set; anything unreadable falls back to defaults. */
export function parseGroupTaskEntropyP0Config(raw: string | null | undefined): GroupTaskEntropyP0Config {
  if (!raw) return { ...DEFAULT_GROUP_TASK_ENTROPY_P0 };
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof GroupTaskEntropyP0Config, unknown>>;
    return {
      floorGate: typeof parsed.floorGate === 'boolean' ? parsed.floorGate : true,
      ackTemplate: typeof parsed.ackTemplate === 'boolean' ? parsed.ackTemplate : true,
      logFold: typeof parsed.logFold === 'boolean' ? parsed.logFold : true,
    };
  } catch {
    return { ...DEFAULT_GROUP_TASK_ENTROPY_P0 };
  }
}

/**
 * Ceremony-shaped ACK line: starts with [WORKING] or [STANDBY], carries no
 * question mark, no deliverable-style URI, and stays short — substantive
 * status updates (blockers, switch-overs, anything >200 chars) must reach
 * the chair. The question guard is deliberate too — a worker smuggling a
 * real question into its ACK still reaches the chair.
 *
 * Task #51: so is a [WORKING] line asking the chair for a RULING. Workers
 * phrase those without a question mark ("…一处需要 chair 裁定"), and the
 * ceremony gate used to swallow them — the chair never got a turn and the
 * step stalled until something else happened to drive it. Any ruling /
 * approval / blocker keyword keeps the line OUT of the ceremony class.
 */
const CEREMONY_ACK_MAX_CHARS = 200;

/** Ruling/approval/blocker keywords that exempt a [WORKING] line from ceremony. */
const CEREMONY_RULING_RE = /(裁定|裁决|定夺|请示|批准|确认一下|decision|approve|blocked)/i;

export function isCeremonyAckLine(content: string): boolean {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return false;
  if (!(trimmed.startsWith('[WORKING]') || trimmed.startsWith('[STANDBY]'))) return false;
  if (trimmed.length > CEREMONY_ACK_MAX_CHARS) return false;
  if (/(pin|metafile|metaapp|https?):\/\//.test(trimmed)) return false;
  if (trimmed.includes('?') || trimmed.includes('？')) return false;
  if (CEREMONY_RULING_RE.test(trimmed)) return false;
  return true;
}

export const GROUP_LOG_MESSAGE_MAX_CHARS = 600;
const GROUP_LOG_TAIL_CHARS = 200;

/**
 * Head+tail truncation for one group-log message: heads carry the intent,
 * tails carry deliverable URIs / verdict tags, so both ends are kept and the
 * middle is elided with an explicit marker. Truncation goes through the
 * llmSafeText code-unit helpers — a bare slice can split a surrogate pair
 * and produce the lone-surrogate payload that JSON-rejecting providers
 * refuse (see the llmSafeText.ts header rules).
 */
export function truncateGroupLogLine(content: string, maxChars = GROUP_LOG_MESSAGE_MAX_CHARS): string {
  const text = content ?? '';
  if (text.length <= maxChars) return text;
  const headChars = Math.max(1, maxChars - GROUP_LOG_TAIL_CHARS - 3);
  return `${truncateUtf16Units(text, headChars)} … ${truncateUtf16UnitsFromEnd(text, GROUP_LOG_TAIL_CHARS)}`;
}

export interface GroupLogEntry {
  senderName: string;
  content: string;
  suspect?: boolean;
  isTrigger?: boolean;
}

/**
 * Render the group log window: truncate every line, then fold runs of
 * consecutive ceremony ACK lines (never the triggering message) into a single
 * counter line. Folding is skipped entirely when `fold` is false.
 */
export function renderGroupLogLines(
  entries: GroupLogEntry[],
  options: { fold?: boolean } = {},
): string[] {
  const fold = options.fold !== false;
  const lines: string[] = [];
  let foldNames: string[] = [];
  const flushFold = () => {
    if (foldNames.length === 0) return;
    const names = [...new Set(foldNames.filter(Boolean))];
    lines.push(
      `- [folded] ${foldNames.length} acknowledgment/standby line(s) omitted`
      + (names.length > 0 ? ` (${names.join(', ')})` : ''),
    );
    foldNames = [];
  };
  for (const entry of entries) {
    const line = `${entry.senderName}${entry.suspect ? ' [SUSPECT]' : ''}: ${truncateGroupLogLine(entry.content)}`;
    if (fold && !entry.isTrigger && isCeremonyAckLine(entry.content)) {
      foldNames.push(entry.senderName);
      continue;
    }
    flushFold();
    lines.push(entry.isTrigger ? `>>> ${line} <<< (the message you are responding to)` : line);
  }
  flushFold();
  return lines;
}
