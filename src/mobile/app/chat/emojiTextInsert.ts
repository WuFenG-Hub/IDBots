/**
 * Caret-aware emoji insertion for the mobile chat composer (pure core).
 *
 * The composer keeps a "pending caret" when the textarea is NOT focused
 * (emoji panel open, software keyboard hidden — the WeChat-style flow):
 * selections are then taken from the remembered caret instead of the DOM.
 * After each pick the ChatScreen applies the returned caret to the
 * textarea once the controlled draft has re-rendered (post-render
 * restore), so consecutive picks chain at the right position and the
 * caret is already placed when the user taps back into the textarea.
 * Picking never refocuses the textarea: the software keyboard must stay
 * hidden while the panel drives input.
 *
 * This module owns only the pure string math so it stays unit-testable.
 */

export interface EmojiInsertion {
  /** The draft text after inserting the emoji. */
  text: string;
  /** UTF-16 code-unit index where the next insertion should land. */
  caret: number;
}

const clampIndex = (index: number, text: string): number => {
  if (!Number.isFinite(index)) return text.length;
  if (index < 0) return 0;
  if (index > text.length) return text.length;
  return index;
};

/**
 * Insert `emoji` at the selection (replacing it when start !== end).
 * A null selection appends at the end of the draft. Indices are UTF-16
 * code units — the same coordinate system as HTMLTextAreaElement's
 * selectionStart/selectionEnd, so browser caret positions feed in verbatim
 * and surrogate-pair emoji never split (the browser itself only reports
 * grapheme-boundary carets).
 */
export function insertEmojiAtCaret(
  draft: string,
  emoji: string,
  selection: { start: number; end: number } | null,
): EmojiInsertion {
  const text = draft ?? '';
  if (!emoji) return { text, caret: selection ? clampIndex(selection.end, text) : text.length };
  const start = clampIndex(selection ? Math.min(selection.start, selection.end) : text.length, text);
  const end = clampIndex(selection ? Math.max(selection.start, selection.end) : text.length, text);
  return {
    text: text.slice(0, start) + emoji + text.slice(end),
    caret: start + emoji.length,
  };
}
