// LLM turn-acknowledgment reply — the turn's first bubble.
//
// The template phrase pools (renderer turnAckPhrases.ts) cover the instant
// 0-1s window inside the activity indicators, but the owner's requirement is
// a REAL assistant bubble, written by the LLM about THIS message, arriving
// while the kernel turn is still pre-flight or reasoning (first-response
// latency). This module holds the pure halves — prompt build and output
// sanitize — so they stay unit-testable under plain `node --test` without
// coworkUtil's electron-bearing import graph. It therefore stays
// dependency-free — including the UTF-16 truncate below, inlined from
// llmSafeText (electron-tsconfig forbids .ts-suffixed imports, so importing
// it here would break the plain-node test path).

/** Hard display cap: an ack is 1-2 sentences, never a paragraph. */
export const TURN_ACK_REPLY_MAX_CHARS = 160;

/** Input cap for the user-text slice sent to the ack model. */
const TURN_ACK_USER_TEXT_MAX_CHARS = 1200;

/** Input cap for the session-title context line. */
const TURN_ACK_TITLE_MAX_CHARS = 120;

/** UTF-16-unit prefix cut that never splits a surrogate pair (llmSafeText). */
function truncateUtf16UnitsSafe(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export interface TurnAckReplyInput {
  userText: string;
  sessionTitle?: string | null;
}

/**
 * Prompt messages for the one-shot ack call (pure). The system prompt is
 * English per the repo's prompt convention; the ack itself must come back in
 * the user's own language, which the prompt demands.
 */
export function buildTurnAckReplyMessages(
  input: TurnAckReplyInput
): Array<{ role: 'system' | 'user'; content: string }> {
  const userText = input.userText.trim();
  const title = (input.sessionTitle ?? '').trim();
  const titleLine = title ? `Session title: ${truncateUtf16UnitsSafe(title, TURN_ACK_TITLE_MAX_CHARS)}\n\n` : '';
  return [
    {
      role: 'system',
      content: [
        'You write the opening acknowledgment of a chat assistant. The user just sent a message; the full reply is being prepared separately and will appear after yours.',
        'Write ONE short acknowledgment that confirms you received and understood the request and says in plain words what you are about to do for it.',
        'Rules: 1-2 sentences, under 40 words. Same language as the user message. Do not answer, solve, or start the task. Do not promise results or time limits, and do not ask questions. No markdown, lists, quotes, emoji, or greetings. Output only the acknowledgment text.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `${titleLine}User message:\n${truncateUtf16UnitsSafe(userText, TURN_ACK_USER_TEXT_MAX_CHARS)}`,
    },
  ];
}

/** Normalize a raw ack completion into display text ('' when unusable). */
export function sanitizeTurnAckReply(raw: string): string {
  let text = (raw ?? '')
    // Stray code fences despite the no-markdown rule.
    .replace(/```[a-zA-Z]*\r?\n?/g, '')
    .replace(/```/g, '')
    .trim();
  // Wrapping quotes the model may add anyway (same set as title sanitizing).
  text = text.replace(/^["'`«»「」『』]+|["'`«»「」『』]+$/g, '').trim();
  // One-line it: the ack renders as a single short bubble.
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= TURN_ACK_REPLY_MAX_CHARS) return text;
  const capped = truncateUtf16UnitsSafe(text, TURN_ACK_REPLY_MAX_CHARS);
  const lastStop = Math.max(
    capped.lastIndexOf('.'),
    capped.lastIndexOf('。'),
    capped.lastIndexOf('!'),
    capped.lastIndexOf('！'),
    capped.lastIndexOf('?'),
    capped.lastIndexOf('？')
  );
  // Keep the last complete sentence when one fits; otherwise hard-cap.
  const cut = lastStop > TURN_ACK_REPLY_MAX_CHARS * 0.5 ? lastStop + 1 : TURN_ACK_REPLY_MAX_CHARS;
  return capped.slice(0, cut).trimEnd();
}
