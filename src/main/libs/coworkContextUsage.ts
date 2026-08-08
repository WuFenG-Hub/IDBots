import type { CoworkMessage } from '../coworkStore';
import type { CoworkModelLimits } from './coworkModelLimits';
import { getCoworkContextBudget } from './coworkContextBudget';

/**
 * Per-session token/cost usage accumulated from SDK result events. The proxy
 * translates DeepSeek's OpenAI usage into Anthropic cache fields, so
 * cacheRead = prompt_cache_hit and cacheCreation = prompt_cache_miss.
 */
export interface CoworkUsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** SDK-priced cost (Anthropic direct sessions only; proxy providers use local rates). */
  totalCostUsd?: number;
  /** Where the numbers came from: 'deepseek' via proxy, 'anthropic' direct, or none. */
  source: 'deepseek' | 'anthropic' | 'none';
  /**
   * Cumulative per-model token usage from the SDK's modelUsage breakdown,
   * including subagent/side-job traffic the top-level counters miss.
   */
  perModelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }>;
}

export interface CoworkContextUsage {
  /** Estimated tokens currently consumed by the conversation (system prompt + messages). */
  usedTokens: number;
  /** The model's total context window in tokens. */
  contextWindow: number;
  /** usedTokens / contextWindow, clamped to [0, 1]. */
  usageRatio: number;
  /**
   * When true, usedTokens/contextWindow come from the SDK's getContextUsage()
   * (real per-category accounting) rather than the local heuristic estimator.
   * Only available in local mode after at least one completed turn.
   */
  isRealUsage?: boolean;
  /** Per-category token breakdown from getContextUsage() (local mode only). */
  categories?: Array<{ name: string; tokens: number; color?: string }>;
}

export interface CoworkContextUsageInput {
  messages: Array<Pick<CoworkMessage, 'type' | 'content' | 'metadata'>>;
  systemPrompt?: string;
  modelLimits: Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens'>;
  /**
   * When set, only the most recent N messages are counted. A2A private chats
   * rebuild the model context every turn from only the latest segment messages
   * (see PRIVATE_CHAT_CONTEXT_MAX_MESSAGES), so their usage estimate must be
   * capped the same way instead of counting the full session history.
   */
  maxRecentMessages?: number;
}

/**
 * Computes the conversation's context-window usage for display purposes,
 * reusing the same estimator that drives auto-compaction so the indicator
 * stays consistent with actual runner behavior.
 */
export function computeCoworkContextUsage(input: CoworkContextUsageInput): CoworkContextUsage {
  const contextWindow = Math.max(0, Math.floor(input.modelLimits.contextWindow));
  const maxRecentMessages = input.maxRecentMessages;
  const messages = Number.isFinite(maxRecentMessages) && (maxRecentMessages as number) > 0
    ? input.messages.slice(-Math.floor(maxRecentMessages as number))
    : input.messages;
  const budget = getCoworkContextBudget({
    messages,
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
