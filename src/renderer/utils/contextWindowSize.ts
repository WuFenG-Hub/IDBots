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
 * Output ceiling pinned onto every newly created model entry, matching the
 * main-process default for uncatalogued ids (128K — mainstream models cap
 * output far above the old 32K, and thinking shares the budget). The ceiling
 * only caps generation and costs nothing for short replies since billing is
 * by actual tokens used. Note the RESOLVED ceiling is additionally clamped
 * against the context window in the main process — see
 * effectiveMaxOutputForWindow below.
 */
export const NEW_MODEL_DEFAULT_MAX_OUTPUT_TOKENS = 128_000;

/**
 * Renderer mirror of the main-process output-ceiling clamp
 * (src/main/libs/coworkModelLimits.ts — clampCoworkMaxOutputTokens; keep the
 * tier boundary, ratios, and floor in sync). The kernel's proactive
 * compaction budget is window - reservedOutput - headroom, with a 90%
 * threshold tier for small windows and 80% for large ones — so the resolved
 * output ceiling never exceeds 6% of a small (<256K) window or 32% of a
 * large one. The model form surfaces this so a user typing a small window
 * understands why the effective output cap is lower than the pinned 128K.
 */
export function effectiveMaxOutputForWindow(contextWindow: number, configuredMaxOutput: number = NEW_MODEL_DEFAULT_MAX_OUTPUT_TOKENS): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return configuredMaxOutput;
  const ratio = contextWindow < 262_144 ? 0.06 : 0.32;
  const windowCap = Math.max(8_192, Math.floor(contextWindow * ratio));
  return Math.min(configuredMaxOutput, windowCap);
}

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
