/**
 * Retry policy for private-chat skill turns.
 *
 * Chat-skill A2A turns used to stay unprocessed forever after any failure so a
 * later poll could deliver a reply. Quota/auth errors never recover that way,
 * and the 5s poll turned them into an unbounded startSession loop that flooded
 * the session with system errors and blanked the A2A view.
 */

export type PrivateChatSkillTurnErrorKind = 'terminal' | 'retryable';

/** Total skill-turn attempts (original + retries) before giving up. */
export const PRIVATE_CHAT_SKILL_TURN_MAX_ATTEMPTS = 3;

const SKILL_TURN_RETRY_BACKOFF_MS = [15_000, 60_000, 240_000] as const;

const toErrorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error == null) return '';
  return String(error);
};

export const classifyPrivateChatSkillTurnError = (error: unknown): PrivateChatSkillTurnErrorKind => {
  const text = toErrorText(error).toLowerCase();
  if (
    text.includes('free_quota_exhausted')
    || text.includes('insufficient_quota')
    || text.includes('"code":"quota"')
    || text.includes("'code':'quota'")
    || text.includes('invalid_api_key')
    || text.includes('authentication_error')
    || text.includes('unauthorized')
    || /(?:^|[^0-9])401(?:[^0-9]|$)/.test(text)
    || /(?:^|[^0-9])403(?:[^0-9]|$)/.test(text)
  ) {
    return 'terminal';
  }
  return 'retryable';
};

export const shouldRetryPrivateChatSkillTurn = (input: {
  error: unknown;
  attempts: number;
}): boolean => {
  if (classifyPrivateChatSkillTurnError(input.error) === 'terminal') {
    return false;
  }
  return input.attempts < PRIVATE_CHAT_SKILL_TURN_MAX_ATTEMPTS;
};

export const nextSkillTurnRetryAt = (attempts: number, now: number = Date.now()): number => {
  const index = Math.max(0, Math.min(SKILL_TURN_RETRY_BACKOFF_MS.length - 1, attempts - 1));
  return now + SKILL_TURN_RETRY_BACKOFF_MS[index];
};
