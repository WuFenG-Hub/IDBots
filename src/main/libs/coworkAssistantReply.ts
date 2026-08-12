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
