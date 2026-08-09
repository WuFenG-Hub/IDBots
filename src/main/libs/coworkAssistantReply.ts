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
