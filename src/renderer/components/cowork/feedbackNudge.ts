/**
 * Feedback-desert nudge (dream review P2-2). message_feedback had ZERO rows
 * since launch — RLHF starves at the source. This pure module decides when
 * the cowork UI shows one low-key hint: a session has produced ≥5 assistant
 * messages and still has NO thumbs up/down anywhere in it.
 *
 * 2026-10-23 redesign (owner feedback): the hint is now a GLOBAL ONE-SHOT
 * notice instead of a per-session one. Being told once is enough — once it
 * has been displayed in any session (or dismissed), no session ever shows it
 * again. The per-session variant made owners close the same banner over and
 * over across sessions.
 *
 * Kept separate from the React component so the decision logic is unit-
 * testable without a renderer harness.
 */

/** Sessions shorter than this never see the hint (nothing to judge yet). */
export const FEEDBACK_NUDGE_MIN_ASSISTANT_MESSAGES = 5;

export interface FeedbackNudgeInput {
  /** Assistant messages in the current session. */
  assistantMessageCount: number;
  /** Messages in this session that already carry a rating (either direction). */
  sessionFeedbackCount: number;
  /** The one-shot has been consumed (shown once or dismissed), globally. */
  done: boolean;
}

/**
 * Show the hint exactly when the session is mature (≥5 assistant messages),
 * completely unrated, and the global one-shot is still unconsumed. ANY
 * feedback in the session kills it (the user found the controls on their
 * own — the desert is over).
 */
export function shouldShowFeedbackNudge(input: FeedbackNudgeInput): boolean {
  if (input.done) return false;
  if (input.sessionFeedbackCount > 0) return false;
  return input.assistantMessageCount >= FEEDBACK_NUDGE_MIN_ASSISTANT_MESSAGES;
}

/** Single global key: set once the hint has been shown or dismissed. */
export const FEEDBACK_NUDGE_DONE_KEY = 'cowork:feedback-nudge-done';

/** Legacy per-session dismiss keys from the P2-2 version, cleared on write. */
const LEGACY_DISMISS_KEY_PREFIX = 'cowork:feedback-nudge-dismissed:';

export function readFeedbackNudgeDone(storage: Pick<Storage, 'getItem'>): boolean {
  try {
    return storage.getItem(FEEDBACK_NUDGE_DONE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeFeedbackNudgeDone(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key'> & { length?: number },
): void {
  try {
    storage.setItem(FEEDBACK_NUDGE_DONE_KEY, '1');
    clearLegacyDismissKeys(storage);
  } catch {
    // Private-mode style storage failures just forgo persistence.
  }
}

function clearLegacyDismissKeys(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key'> & { length?: number },
): void {
  try {
    if (typeof storage.removeItem !== 'function' || typeof storage.key !== 'function') return;
    const legacyKeys: string[] = [];
    const length = typeof storage.length === 'number' ? storage.length : 0;
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (typeof key === 'string' && key.startsWith(LEGACY_DISMISS_KEY_PREFIX)) {
        legacyKeys.push(key);
      }
    }
    for (const key of legacyKeys) storage.removeItem(key);
  } catch {
    // Best-effort cleanup only.
  }
}
