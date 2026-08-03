/**
 * Shared helpers for MetaBot fallback LLM (secondary provider) support.
 * Kept dependency-free so the retry policy can be unit-tested from compiled
 * output without touching real provider configs or the network.
 */

/** Normalize a raw llm id (provider key) for use in LLM calls; null when unusable. */
export function normalizeMetabotLlmId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Resolve the effective fallback llm id: the trimmed fallback when it is
 * non-empty and different from the primary id; otherwise null (no retry).
 */
export function resolveFallbackLlmId(primaryLlmId: unknown, fallbackLlmId: unknown): string | null {
  const fallback = normalizeMetabotLlmId(fallbackLlmId);
  if (!fallback) return null;
  const primary = normalizeMetabotLlmId(primaryLlmId);
  if (primary && fallback === primary) return null;
  return fallback;
}

export interface LlmFallbackCallOptions {
  llmId?: string | null;
  fallbackLlmId?: string | null;
}

/**
 * Run `attempt` with the primary llm id; when it throws (config resolution
 * failure or API call failure), retry exactly once with the fallback llm id
 * when one is configured and differs from the primary. Rethrows the primary
 * error when no fallback is available or the fallback attempt also fails.
 */
export async function runWithLlmFallback<TResult, TOptions extends LlmFallbackCallOptions>(
  options: TOptions,
  attempt: (options: TOptions) => Promise<TResult>,
  log: (message: string) => void = console.log
): Promise<TResult> {
  try {
    return await attempt(options);
  } catch (primaryError) {
    const fallbackId = resolveFallbackLlmId(options.llmId, options.fallbackLlmId);
    if (!fallbackId) {
      throw primaryError;
    }
    const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
    const primaryLabel = normalizeMetabotLlmId(options.llmId) ?? 'default';
    log(`[LLM Fallback] Primary LLM '${primaryLabel}' failed (${primaryMessage}); retrying once with fallback '${fallbackId}'.`);
    try {
      return await attempt({ ...options, llmId: fallbackId, fallbackLlmId: null });
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      console.error(`[LLM Fallback] Fallback LLM '${fallbackId}' also failed: ${fallbackMessage}`);
      throw primaryError;
    }
  }
}
