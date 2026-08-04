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
