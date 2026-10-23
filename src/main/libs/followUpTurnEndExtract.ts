/**
 * Turn-end input extraction for the Follow-Up Tasks (待跟进任务) cerebellum
 * gate. Pure and Electron-free so unit tests load it directly.
 *
 * Regression guard: CoworkStore.getSessionMessagesPage hands pages over
 * OLDEST-FIRST (see getTranscriptSessionMessagesPage — "Rows arrive
 * newest-first and are handed over oldest-first"). Reading the turn's final
 * message with Array.find() therefore picks the OLDEST message of the window
 * — for long-lived scheduled sessions that is a stale benign intermediate and
 * the classifier never sees the CRITICAL final report. Always scan from the
 * end.
 */

export interface TurnEndFollowUpMessage {
  type: string;
  content?: string | null;
  metadata?: {
    isThinking?: boolean;
    origin?: string;
    originLabel?: unknown;
  } | null;
}

export interface TurnEndFollowUpInput {
  lastAssistantText: string;
  /** Present only when the window's latest user message is a scheduled run. */
  taskName?: string;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

/**
 * Pick the turn-ending assistant message (and the scheduled task name when the
 * latest user message is a schedule-origin submission) from an OLDEST-FIRST
 * message page. Returns null when no usable assistant text exists.
 */
export function extractTurnEndFollowUpInput(
  messages: readonly TurnEndFollowUpMessage[],
): TurnEndFollowUpInput | null {
  const assistantIndex = findLastIndex(
    messages,
    (message) =>
      message.type === 'assistant'
      && Boolean(message.content?.trim())
      && message.metadata?.isThinking !== true,
  );
  if (assistantIndex < 0) return null;
  const lastAssistantText = messages[assistantIndex].content as string;

  const userIndex = findLastIndex(messages, (message) => message.type === 'user');
  const lastUser = userIndex >= 0 ? messages[userIndex] : undefined;
  const taskName =
    lastUser?.metadata?.origin === 'schedule' && typeof lastUser.metadata.originLabel === 'string'
      ? lastUser.metadata.originLabel
      : undefined;

  return { lastAssistantText, ...(taskName ? { taskName } : {}) };
}
