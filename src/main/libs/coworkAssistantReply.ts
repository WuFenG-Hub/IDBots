/**
 * Shared helpers for deciding whether an assistant message is a *usable*
 * final reply/handoff.
 *
 * The DeepSeek Responses path in coworkOpenAICompatProxy injects
 * `DEEPSEEK_RESPONSES_REASONING_PLACEHOLDER` into request history when
 * reasoning is unrecoverable. On some upstreams that placeholder also
 * round-trips back as thinking content and gets persisted as an assistant
 * message. Any consumer that extracts a "final reply" (skill-turn bridge,
 * worker delegation, group daemon) must treat that text as empty instead of
 * handing a fake "completed" result to the caller.
 */
export const DEEPSEEK_RESPONSES_REASONING_PLACEHOLDER = '[reasoning unavailable]';

/**
 * Cue fed back to the model when an empty terminal turn is auto-continued
 * (DeepSeek emitted only a reasoning block, then `end_turn`, with no text and
 * no tool_use). Mirrors the manual "继续" workaround: resume the session (full
 * history preserved) with a minimal instruction so the model performs the step
 * it clearly intended. This is real answer text — NOT the DeepSeek
 * `[reasoning unavailable]` placeholder — so `isNonAnswerAssistantReply` must
 * treat it as a genuine message and it can never itself look like another
 * empty terminal turn.
 */
export const EMPTY_TERMINAL_TURN_CONTINUE_PROMPT =
  'The previous turn ended without producing any output or tool action. Continue the task from where you left off and perform the next step.';

/**
 * Provider failure codes that mean "the request never got answered for
 * environmental reasons" — network unreachable (TRANSPORT), request timed out
 * (TIMEOUT), provider 429/5xx (RATE_LIMIT/SERVER), or a stream that closed
 * without any content (EMPTY_RESPONSE). These carry no information about the
 * model's own behavior: the same prompt is perfectly answerable once the
 * environment recovers, so the turn is worth resuming instead of failing the
 * task behind it.
 */
export const TRANSIENT_TURN_ERROR_CODES: ReadonlySet<string> = new Set([
  'TRANSPORT',
  'TIMEOUT',
  'RATE_LIMIT',
  'SERVER',
  'EMPTY_RESPONSE',
]);

/**
 * Cue fed back to the model when a DSH turn died on a transient error (see
 * TRANSIENT_TURN_ERROR_CODES) and the runner auto-resumes it. Full session
 * history — including every tool result of the interrupted turn — is
 * preserved, so the model picks up exactly where the environment cut it off;
 * no tool side effects are replayed.
 */
export const TRANSIENT_TURN_RESUME_PROMPT =
  'The previous turn was interrupted by a transient network or provider failure. Continue the task from where you left off.';

/** True when a DSH turn outcome is an error whose failure code is transient
 *  (environmental) and therefore worth an automatic turn-level resume. */
export function isTransientDshTurnError(outcome: { kind?: string; error?: { code?: string } }): boolean {
  if (outcome?.kind !== 'error') return false;
  const code = outcome.error?.code;
  return typeof code === 'string' && TRANSIENT_TURN_ERROR_CODES.has(code);
}

const NON_ANSWER_PLACEHOLDERS = new Set<string>([
  DEEPSEEK_RESPONSES_REASONING_PLACEHOLDER,
]);

/** True when a candidate assistant reply is empty or a known non-answer placeholder. */
export function isNonAnswerAssistantReply(text: string): boolean {
  const trimmed = String(text ?? '').trim();
  return trimmed.length === 0 || NON_ANSWER_PLACEHOLDERS.has(trimmed);
}

/**
 * True when an SDK `result` event (already known to be a success — callers
 * gate on `subtype === 'success'`) carries no usable final reply text.
 *
 * `payload.result` is the SDK's authoritative final-answer string for the
 * turn. When it is missing/empty/whitespace, the terminal assistant message
 * had no text — the DeepSeek thinking-placeholder truncation signature (the
 * model emitted only `[reasoning unavailable]` reasoning, then `end_turn`).
 * Intermediate progress notes do NOT count: they precede further tool work,
 * and the SDK still populates `result` with the real final answer when one
 * exists. Used by the empty-terminal-turn guard in CoworkRunner so such turns
 * are not falsely reported as `completed`.
 */
export function isEmptyTerminalSdkResult(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return true;
  const result = (payload as Record<string, unknown>).result;
  return !(typeof result === 'string' && result.trim().length > 0);
}
