import type { CoworkMessage } from '../coworkStore';
import type { CoworkModelLimits } from './coworkModelLimits';

export const COWORK_CONTEXT_SOFT_THRESHOLD_RATIO = 0.82;
// When the SDK owns proactive compaction (coworkSdkAutoCompact), IDBots' own
// tier-1/tier-2 compaction stays as a safety net near the real ceiling so the
// two mechanisms do not double-compact at the same threshold.
export const COWORK_CONTEXT_SAFETY_NET_RATIO = 0.95;
const MESSAGE_FRAME_TOKEN_OVERHEAD = 4;

type CoworkContextMessage = Pick<CoworkMessage, 'type' | 'content' | 'metadata'>;

export interface CoworkContextBudgetInput {
  messages: CoworkContextMessage[];
  modelLimits: Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens'>;
  currentPrompt?: string;
  systemPrompt?: string;
  softThresholdRatio?: number;
  /**
   * Real total input tokens from the most recent LLM turn (provider-reported,
   * cached + uncached). When available it is the authoritative context size; the
   * heuristic estimate is kept as the floor so a missing/stale real value still
   * compacts on the store-based estimate.
   */
  realUsageTokens?: number;
}

export interface CoworkContextBudget {
  estimatedTokens: number;
  usableInputTokens: number;
  softThresholdTokens: number;
  includedMessages: number;
  shouldCompact: boolean;
}

function countCjkCodepoints(value: string): number {
  let count = 0;
  for (const char of value) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(char)) {
      count += 1;
    }
  }
  return count;
}

export function estimateCoworkTextTokens(value: string): number {
  if (!value) return 0;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return 0;

  const cjkChars = countCjkCodepoints(normalized);
  const nonCjkChars = Math.max(0, [...normalized].length - cjkChars);
  return Math.max(1, cjkChars + Math.ceil(nonCjkChars / 4));
}

export function shouldIncludeCoworkContextMessage(message: CoworkContextMessage): boolean {
  if (message.metadata?.isThinking === true) {
    return false;
  }
  if (message.metadata?.excludeFromSandboxHistory === true) {
    return false;
  }
  if (message.metadata?.isDelegationInternal === true) {
    return false;
  }
  if (message.type === 'system') {
    return false;
  }
  return Boolean(message.content?.trim());
}

export function estimateCoworkMessageTokens(message: CoworkContextMessage): number {
  if (!shouldIncludeCoworkContextMessage(message)) {
    return 0;
  }
  return estimateCoworkTextTokens(message.content) + MESSAGE_FRAME_TOKEN_OVERHEAD;
}

function isCurrentPromptAlreadyPresent(messages: CoworkContextMessage[], currentPrompt: string): boolean {
  const trimmedPrompt = currentPrompt.trim();
  if (!trimmedPrompt) return false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!shouldIncludeCoworkContextMessage(message)) {
      continue;
    }
    if (message.type !== 'user') {
      return false;
    }
    return message.content.trim() === trimmedPrompt;
  }

  return false;
}

function clampSoftThresholdRatio(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return COWORK_CONTEXT_SOFT_THRESHOLD_RATIO;
  }
  return Math.max(0.1, Math.min(0.98, Number(value)));
}

export function getCoworkContextBudget(input: CoworkContextBudgetInput): CoworkContextBudget {
  const usableInputTokens = Math.max(1, Math.floor(input.modelLimits.contextWindow - input.modelLimits.maxOutputTokens));
  const softThresholdRatio = clampSoftThresholdRatio(input.softThresholdRatio);
  const softThresholdTokens = Math.max(1, Math.floor(usableInputTokens * softThresholdRatio));

  let estimatedTokens = input.systemPrompt ? estimateCoworkTextTokens(input.systemPrompt) : 0;
  let includedMessages = 0;

  for (const message of input.messages) {
    const messageTokens = estimateCoworkMessageTokens(message);
    if (messageTokens <= 0) {
      continue;
    }
    estimatedTokens += messageTokens;
    includedMessages += 1;
  }

  const currentPrompt = input.currentPrompt?.trim() ?? '';
  if (currentPrompt && !isCurrentPromptAlreadyPresent(input.messages, currentPrompt)) {
    estimatedTokens += estimateCoworkTextTokens(currentPrompt) + MESSAGE_FRAME_TOKEN_OVERHEAD;
  }

  // Provider-reported input from the last turn is only trusted as the
  // "current context size" when it is a plausible single-request size
  // (0 < input <= contextWindow). Some gateways serving DeepSeek (e.g.
  // opencode.ai/zen/go/v1) report per-turn totals that are far above the
  // model's window (observed 1.5M-3.9M on a 1M model) even though the actual
  // SDK session content is small; trusting those numbers made the context
  // ring show "3M+ used" and made the compaction safety net fire on every
  // turn. When the number is implausible, fall back to the store-history
  // heuristic (which matches what a fresh resume would actually send).
  const contextWindow = Math.max(1, Math.floor(input.modelLimits.contextWindow));
  const rawRealUsage = Number.isFinite(input.realUsageTokens) && (input.realUsageTokens as number) > 0
    ? Math.floor(input.realUsageTokens as number)
    : 0;
  const realUsageTokens = rawRealUsage > 0 && rawRealUsage <= contextWindow ? rawRealUsage : 0;
  if (realUsageTokens > 0) {
    // Provider-reported context size from the last turn is authoritative: it
    // reflects the ACTUAL SDK session (including SDK in-session compaction),
    // so a freshly compacted session does not re-trigger compaction from the
    // store-history heuristic. The new prompt is added on top; the heuristic
    // estimate is only used until the first real usage is reported.
    const currentPromptTokens = currentPrompt && !isCurrentPromptAlreadyPresent(input.messages, currentPrompt)
      ? estimateCoworkTextTokens(currentPrompt) + MESSAGE_FRAME_TOKEN_OVERHEAD
      : 0;
    estimatedTokens = realUsageTokens + currentPromptTokens;
  }

  return {
    estimatedTokens,
    usableInputTokens,
    softThresholdTokens,
    includedMessages,
    shouldCompact: estimatedTokens >= softThresholdTokens,
  };
}

export function isContextWindowExceededError(message: string): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();

  if (
    normalized.includes('reasoning_content')
    && (
      normalized.includes('thinking mode')
      || normalized.includes('deepseek thinking request is missing')
    )
  ) {
    return false;
  }

  return [
    /\b413\b/,
    /payload too large/,
    /request entity too large/,
    /context (?:length|window).*exceed/,
    /maximum context (?:length|window)/,
    /input too long/,
    /prompt too long/,
    /too many tokens/,
    /token limit/,
    /tokens.*exceed/,
  ].some((pattern) => pattern.test(normalized));
}
