/**
 * Shared helpers for MetaBot fallback LLM (secondary brain) support.
 * Kept dependency-light so the retry policy can be unit-tested from compiled
 * output without touching real provider configs or the network.
 */

import type { Metabot } from '../types/metabot';
import { toLlmEffortLevel, type LlmEffortLevel } from '../libs/llmEffort';

/** Normalize a raw llm id (model id or legacy provider key) for use in LLM calls; null when unusable. */
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

/** The metabot brain pair as used by automation LLM calls (A2A chat, group tasks, dreams, impressions). */
export interface MetabotBrainOptions {
  /** Primary brain: model id (new) or legacy provider key. */
  llmId: string | null;
  /** Provider key the primary brain model was picked from. */
  llmProvider: string | null;
  /** Primary brain reasoning effort (off/low/high/max); null = model default. */
  effort: LlmEffortLevel | null;
  fallbackLlmId: string | null;
  fallbackLlmProvider: string | null;
  fallbackEffort: LlmEffortLevel | null;
}

/**
 * Extract a metabot's brain pair: model ids (or legacy provider keys),
 * provider hints, and per-brain reasoning efforts. This is the single seam
 * automation call sites use so the "bot brain = model + effort" rule stays
 * consistent across A2A private chat, group tasks, dreams, impressions, and
 * the guest/order daemons.
 */
export function metabotBrainOptions(metabot: Partial<Pick<Metabot,
  'llm_id' | 'llm_provider' | 'llm_effort' | 'fallback_llm_id' | 'fallback_llm_provider' | 'fallback_llm_effort'
>> | null | undefined): MetabotBrainOptions {
  return {
    llmId: normalizeMetabotLlmId(metabot?.llm_id),
    llmProvider: normalizeMetabotLlmId(metabot?.llm_provider),
    effort: toLlmEffortLevel(metabot?.llm_effort),
    fallbackLlmId: normalizeMetabotLlmId(metabot?.fallback_llm_id),
    fallbackLlmProvider: normalizeMetabotLlmId(metabot?.fallback_llm_provider),
    fallbackEffort: toLlmEffortLevel(metabot?.fallback_llm_effort),
  };
}

export interface LlmFallbackCallOptions {
  llmId?: string | null;
  /** Provider key the primary brain model was picked from. */
  llmProvider?: string | null;
  fallbackLlmId?: string | null;
  /** Provider key the fallback brain model was picked from. */
  fallbackLlmProvider?: string | null;
  /** Effort riding the primary brain (off/low/high/max); null = model default. */
  effort?: LlmEffortLevel | null;
  /** Effort riding the fallback brain; null = model default. */
  fallbackEffort?: LlmEffortLevel | null;
}

/**
 * Run `attempt` with the primary llm id; when it throws (config resolution
 * failure or API call failure), retry exactly once with the fallback llm id
 * when one is configured and differs from the primary. The retry swaps BOTH
 * the model and the effort to the fallback brain's pair. Rethrows the primary
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
    // Callers pass ONE shared abort signal (e.g. AbortSignal.timeout) through
    // options; when the primary attempt consumed it, the fallback attempt
    // would fail instantly with the same abort/timeout — skip the dead retry
    // and surface the primary error directly.
    const sharedSignal = (options as { signal?: AbortSignal }).signal;
    if (sharedSignal?.aborted) {
      throw primaryError;
    }
    const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
    const primaryLabel = normalizeMetabotLlmId(options.llmId) ?? 'default';
    log(`[LLM Fallback] Primary LLM '${primaryLabel}' failed (${primaryMessage}); retrying once with fallback '${fallbackId}'.`);
    try {
      return await attempt({
        ...options,
        llmId: fallbackId,
        llmProvider: options.fallbackLlmProvider ?? null,
        fallbackLlmId: null,
        fallbackLlmProvider: null,
        effort: options.fallbackEffort ?? null,
      });
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      console.error(`[LLM Fallback] Fallback LLM '${fallbackId}' also failed: ${fallbackMessage}`);
      throw primaryError;
    }
  }
}
