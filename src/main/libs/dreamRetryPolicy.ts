/**
 * Retry policy for dream runs (H-80).
 *
 * Dream scheduling used to treat every failure as transient: the failed-run
 * branch only looked at startedAt + exponential backoff, so a deterministic
 * provider rejection — e.g. glm-5.3-flash's `400 … 1210: 该模型始终思考，不
 * 支持关闭思考` passed through the Anthropic-compatible route — was retried
 * forever at the 6h-capped backoff with no terminal state and nothing the
 * owner could see. classifyDreamError sorts errors into terminal (never
 * retry) vs retryable (bounded backoff), and DREAM_RETRY_MAX_ATTEMPTS
 * degrades dates whose retry budget is exhausted instead of retrying forever.
 */

export type DreamErrorKind = 'terminal' | 'retryable';

/** Total scheduled attempts (original + retries) before a retryable failure
 * stops auto-retrying: the run is marked terminal-failed and only a manual
 * dream run can revive the date. */
export const DREAM_RETRY_MAX_ATTEMPTS = 5;

/** 4xx statuses that are transient by nature and stay in the retry class. */
const RETRYABLE_4XX_STATUSES = new Set([408, 429]);

const toErrorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error == null) return '';
  return String(error);
};

// cognitiveChatCompletion throws `LLM request failed: <status> <body>` on
// every provider route (Anthropic, OpenAI-compatible, DeepSeek Responses), so
// the passthrough status is anchored to that prefix — body numbers like the
// zhipu error id `1210:` must not read as statuses. llmFallback's combined
// error keeps the primary message first, so the first match is the primary
// route's status.
const LLM_STATUS_PATTERN = /llm request failed:\s*(\d{3})/;

// Deterministic provider rejections without a passthrough status (quota,
// auth, parameter shape) — mirrors privateChatSkillTurnPolicy's list.
const TERMINAL_ERROR_PATTERNS = [
  'invalid_request_error',
  'invalid_api_key',
  'authentication_error',
  'model_not_found',
  'unauthorized',
  'free_quota_exhausted',
  'insufficient_quota',
  '"code":"quota"',
  "'code':'quota'",
];

const boundaryCode = (status: number): RegExp => new RegExp(`(?:^|[^0-9])${status}(?:[^0-9]|$)`);

export const classifyDreamError = (error: unknown): DreamErrorKind => {
  const text = toErrorText(error).toLowerCase();
  if (TERMINAL_ERROR_PATTERNS.some((pattern) => text.includes(pattern))) {
    return 'terminal';
  }
  if (boundaryCode(401).test(text) || boundaryCode(403).test(text)) {
    return 'terminal';
  }
  const statusMatch = LLM_STATUS_PATTERN.exec(text);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status >= 400 && status < 500 && !RETRYABLE_4XX_STATUSES.has(status)) {
      return 'terminal';
    }
  }
  return 'retryable';
};
