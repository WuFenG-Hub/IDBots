import type { CoworkModelLimits } from './coworkModelLimits';

/**
 * SDK built-in auto-compact enablement for non-Claude models with known
 * context windows (DeepSeek V4 1M, Qwen, GLM, Gemini, ...).
 *
 * Why this exists: the Claude Agent SDK 0.3.x native CLI falls back to a 200K
 * context window for model ids it does not recognize and skips its built-in
 * auto-compact gate entirely when the auto-compact window source is "auto"
 * (the unknown-model fallback). IDBots therefore never got SDK-side proactive
 * compaction for DeepSeek et al., and sessions grew until the provider
 * rejected them. Passing the real window via CLAUDE_CODE_MAX_CONTEXT_TOKENS
 * (only honored by the CLI for non-`claude-*` model ids) plus an explicit
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW makes the CLI's auto-compact (including the
 * reactive/segmented path) run at the intended threshold.
 */

/** CLI minimum/maximum accepted values for the auto-compact window (100k–1M). */
export const COWORK_SDK_AUTO_COMPACT_MIN_WINDOW = 100_000;
export const COWORK_SDK_AUTO_COMPACT_MAX_WINDOW = 1_000_000;
/** CLI reserves min(maxOutputTokens, 20k) from the window before comparing. */
export const COWORK_SDK_AUTO_COMPACT_OUTPUT_RESERVE_TOKENS = 20_000;
/** CLI compacts at (effective window - 13k) tokens. */
export const COWORK_SDK_AUTO_COMPACT_THRESHOLD_RESERVE_TOKENS = 13_000;
/** Keep the original IDBots 82% intent for when the SDK should compact. */
export const COWORK_SDK_AUTO_COMPACT_RATIO = 0.82;

export interface CoworkSdkAutoCompactEnv {
  env: Record<string, string>;
  autoCompactWindow: number;
}

function isClaudeModelId(modelId: string): boolean {
  return modelId.toLowerCase().startsWith('claude-');
}

/**
 * True when the SDK's built-in auto-compact can be safely enabled for this
 * model: a non-Claude model id with limits we trust (provider/available/
 * known-model, not the generic fallback) and a context window large enough
 * for the CLI's 100k minimum auto-compact window.
 */
export function shouldEnableSdkAutoCompact(
  modelLimits: Pick<CoworkModelLimits, 'modelId' | 'contextWindow' | 'maxOutputTokens' | 'source'>
): boolean {
  const modelId = typeof modelLimits.modelId === 'string' ? modelLimits.modelId.trim() : '';
  if (!modelId) return false;
  if (isClaudeModelId(modelId)) return false;
  if (modelLimits.source === 'fallback') return false;
  if (!Number.isFinite(modelLimits.contextWindow) || modelLimits.contextWindow < COWORK_SDK_AUTO_COMPACT_MIN_WINDOW) {
    return false;
  }
  return true;
}

/**
 * Build the per-session env override that makes the CLI auto-compact at
 * ~82% of the model's usable input window:
 *
 *   CLAUDE_CODE_MAX_CONTEXT_TOKENS = contextWindow
 *   CLAUDE_CODE_AUTO_COMPACT_WINDOW = usable * 0.82
 *                                     + min(maxOutputTokens, 20k) + 13k
 *
 * The +20k/+13k terms reverse the CLI's own threshold math
 * (compact at window - min(maxOutput, 20k) - 13k) so the actual trigger lands
 * at 82% of usable input. The window is clamped to the CLI's accepted range
 * [100k, min(1M, contextWindow)].
 *
 * Returns null when SDK auto-compact should not be enabled for the model.
 */
export function buildCoworkSdkAutoCompactEnv(
  modelLimits: Pick<CoworkModelLimits, 'modelId' | 'contextWindow' | 'maxOutputTokens' | 'source'>
): CoworkSdkAutoCompactEnv | null {
  if (!shouldEnableSdkAutoCompact(modelLimits)) {
    return null;
  }

  const contextWindow = Math.floor(modelLimits.contextWindow);
  const maxOutputTokens = Math.max(1, Math.floor(modelLimits.maxOutputTokens));
  const usableInputTokens = Math.max(1, contextWindow - maxOutputTokens);
  const rawWindow = usableInputTokens * COWORK_SDK_AUTO_COMPACT_RATIO
    + Math.min(maxOutputTokens, COWORK_SDK_AUTO_COMPACT_OUTPUT_RESERVE_TOKENS)
    + COWORK_SDK_AUTO_COMPACT_THRESHOLD_RESERVE_TOKENS;
  const autoCompactWindow = Math.max(
    COWORK_SDK_AUTO_COMPACT_MIN_WINDOW,
    Math.min(
      Math.min(COWORK_SDK_AUTO_COMPACT_MAX_WINDOW, contextWindow),
      Math.round(rawWindow)
    )
  );

  return {
    env: {
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(autoCompactWindow),
    },
    autoCompactWindow,
  };
}
