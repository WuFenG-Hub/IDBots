// Split model-visible text that embeds chain-of-thought in <think> / <thinking>
// tags (DeepSeek distill, some gateways) into the same thinking/text slots the
// Claude kernel uses. Tags are stripped from the visible reply.

const OPEN_RE = /<think(?:ing)?>/i;
const CLOSE_RE = /<\/think(?:ing)?>/i;

export type SplitThinkTaggedContent = {
  thinking: string;
  text: string;
};

/**
 * Split a complete (or currently-accumulated) assistant string into thinking
 * vs visible text. Unclosed open tags leave the remainder in `thinking`.
 * Strings with no tags return empty thinking and the original text.
 */
export function splitThinkTaggedContent(input: string): SplitThinkTaggedContent {
  if (!input) return { thinking: '', text: '' };
  if (!OPEN_RE.test(input) && !CLOSE_RE.test(input)) {
    return { thinking: '', text: input };
  }

  let thinking = '';
  let text = '';
  let remaining = input;
  let inThink = false;
  // Reset lastIndex — these regexes are reused across calls.
  OPEN_RE.lastIndex = 0;
  CLOSE_RE.lastIndex = 0;

  while (remaining.length > 0) {
    if (inThink) {
      const close = remaining.search(CLOSE_RE);
      if (close === -1) {
        thinking += remaining;
        break;
      }
      thinking += remaining.slice(0, close);
      const matched = remaining.slice(close).match(CLOSE_RE);
      remaining = remaining.slice(close + (matched?.[0].length ?? 0));
      inThink = false;
      continue;
    }

    const open = remaining.search(OPEN_RE);
    if (open === -1) {
      text += remaining;
      break;
    }
    text += remaining.slice(0, open);
    const matched = remaining.slice(open).match(OPEN_RE);
    remaining = remaining.slice(open + (matched?.[0].length ?? 0));
    inThink = true;
  }

  return { thinking, text };
}
