/**
 * Parsing / formatting for the per-model context-window setting exposed in
 * the model add / edit dialogs. The stored value is raw tokens
 * (`ConfiguredModel.contextWindow`); the input additionally accepts K / M
 * shorthand ("128K", "1M") so users can type window sizes the way providers
 * advertise them.
 */

/** Sanity ceiling for a user-entered window (100M tokens is never real). */
export const CONTEXT_WINDOW_INPUT_MAX = 100_000_000;

/**
 * Parse the raw input into a token count.
 *
 * - Empty / whitespace-only input returns `undefined`: the user left the
 *   field at its default, so no explicit `contextWindow` should be persisted
 *   and resolution falls back to the known-model catalog (then 128K).
 * - `null` marks invalid input the caller should surface as a form error.
 */
export function parseContextWindowSizeInput(raw: string): number | null | undefined {
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(\d+(?:\.\d+)?)\s*([KM])?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const value = Number(match[1]) * (match[2] === 'K' ? 1_000 : match[2] === 'M' ? 1_000_000 : 1);
  if (!Number.isSafeInteger(value) || value <= 0 || value > CONTEXT_WINDOW_INPUT_MAX) {
    return null;
  }
  return value;
}

/** Compact display form for a stored token count: 128000 → "128K", 1_000_000 → "1M". */
export function formatContextWindowSize(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return '';
  }
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}M`;
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return `${tokens / 1_000}K`;
  }
  return String(tokens);
}
