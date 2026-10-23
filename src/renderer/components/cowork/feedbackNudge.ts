/**
 * Feedback-desert nudge (dream review P2-2). message_feedback has ZERO rows
 * since launch — RLHF starves at the source. This pure module decides when
 * the cowork UI shows one low-key hint: a session has produced ≥5 assistant
 * messages and still has NO thumbs up/down anywhere in it.
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
  /** The user closed the hint for this session. */
  dismissed: boolean;
}

/**
 * Show the hint exactly when the session is mature (≥5 assistant messages),
 * completely unrated, and not dismissed. ANY feedback in the session kills it
 * forever (the user found the controls on their own — the desert is over).
 */
export function shouldShowFeedbackNudge(input: FeedbackNudgeInput): boolean {
  if (input.dismissed) return false;
  if (input.sessionFeedbackCount > 0) return false;
  return input.assistantMessageCount >= FEEDBACK_NUDGE_MIN_ASSISTANT_MESSAGES;
}

/**
 * localStorage key pinning the once-per-session dismissal. The session id is
 * length-capped (review nit): ids are caller-controlled strings and the key
 * rides the origin's storage quota.
 */
export function feedbackNudgeDismissKey(sessionId: string): string {
  const normalized = String(sessionId ?? '').trim();
  return `cowork:feedback-nudge-dismissed:${normalized.slice(0, 128)}`;
}

export function readFeedbackNudgeDismissed(storage: Pick<Storage, 'getItem'>, sessionId: string): boolean {
  try {
    return storage.getItem(feedbackNudgeDismissKey(sessionId)) === '1';
  } catch {
    return false;
  }
}

export function writeFeedbackNudgeDismissed(storage: Pick<Storage, 'setItem'>, sessionId: string): void {
  try {
    storage.setItem(feedbackNudgeDismissKey(sessionId), '1');
  } catch {
    // Private-mode style storage failures just forgo persistence.
  }
}
