import type { CoworkMessage } from '../coworkStore';
import type { CoworkModelLimits } from './coworkModelLimits';
import { getCoworkContextBudget } from './coworkContextBudget';

export interface CoworkContextUsage {
  /** Estimated tokens currently consumed by the conversation (system prompt + messages). */
  usedTokens: number;
  /** The model's total context window in tokens. */
  contextWindow: number;
  /** usedTokens / contextWindow, clamped to [0, 1]. */
  usageRatio: number;
}

export interface CoworkContextUsageInput {
  messages: Array<Pick<CoworkMessage, 'type' | 'content' | 'metadata'>>;
  systemPrompt?: string;
  modelLimits: Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens'>;
}

/**
 * Computes the conversation's context-window usage for display purposes,
 * reusing the same estimator that drives auto-compaction so the indicator
 * stays consistent with actual runner behavior.
 */
export function computeCoworkContextUsage(input: CoworkContextUsageInput): CoworkContextUsage {
  const contextWindow = Math.max(0, Math.floor(input.modelLimits.contextWindow));
  const budget = getCoworkContextBudget({
    messages: input.messages,
    systemPrompt: input.systemPrompt,
    modelLimits: input.modelLimits,
  });
  const usedTokens = Math.max(0, budget.estimatedTokens);
  const usageRatio = contextWindow > 0
    ? Math.min(1, Math.max(0, usedTokens / contextWindow))
    : 0;

  return {
    usedTokens,
    contextWindow,
    usageRatio,
  };
}
