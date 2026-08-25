/**
 * GT#12 N5: fold low-value polling tool_result blocks during playback assembly.
 *
 * Long orchestration runs accumulate dozens of tiny, repetitive status-polling
 * outputs (e.g. "状态: executing | 消息数: 5"). Each is small, but the
 * repetition is pure context noise with no long-term value. Tier-1 snip
 * (coworkToolResultSnip) cuts by token boundary; this module cuts by CONTENT
 * VALUE: same-shape polling results older than the most recent N are folded
 * into one-line placeholders.
 *
 * Contract:
 * - Only affects the request body assembled for replay (proxy forwarding path).
 *   The cowork store keeps full messages untouched (traceability preserved).
 * - Folding keeps every tool_result block in place (tool_use/tool_result
 *   pairing must stay complete for the upstream API), replacing only the
 *   CONTENT of folded blocks with short placeholders — so it is structurally
 *   safe and never drops a tool_use_id.
 * - Conservative heuristics to avoid hurting normal output: a result must be
 *   short (< 1KB), match a polling-shaped pattern, and the session must have
 *   at least MIN_COUNT such results before anything is folded.
 */

import { stripLoneSurrogates, truncateUtf16Units, truncateUtf16UnitsFromEnd } from './llmSafeText';

/** A result longer than this is never treated as low-value polling output. */
export const LOW_VALUE_TOOL_RESULT_MAX_CHARS = 1024;
/** Only fold when at least this many polling-shaped results exist in the replay. */
export const LOW_VALUE_TOOL_RESULT_MIN_COUNT = 3;
/** Keep this many of the most recent polling results fully intact. */
export const LOW_VALUE_TOOL_RESULT_KEEP_RECENT = 2;

// Polling-shaped output: status/progress vocabulary. Kept deliberately
// narrow — normal answers that merely mention one of these words are usually
// longer than 1KB and thus already excluded by the length cap.
const POLLING_TOOL_RESULT_PATTERN =
  /(状态\s*[:：]|status\s*[:：]|消息数|working|executing|pending|轮询|polling|poll\b|仍在执行|处理中)/i;

export interface FoldLowValueToolResultsStats {
  /** Number of polling-shaped tool_result blocks found in the replay. */
  total: number;
  /** Number of blocks whose content was replaced by a fold placeholder. */
  folded: number;
  /** Number of recent polling blocks kept fully intact. */
  kept: number;
}

export interface FoldLowValueToolResultsResult {
  messages: unknown[];
  stats: FoldLowValueToolResultsStats;
}

export function isLowValuePollingToolResult(content: unknown): boolean {
  if (typeof content !== 'string') {
    return false;
  }
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > LOW_VALUE_TOOL_RESULT_MAX_CHARS) {
    return false;
  }
  return POLLING_TOOL_RESULT_PATTERN.test(trimmed);
}

/** Fold placeholder used for every folded block except the first (summary). */
const FOLD_PLACEHOLDER = '[轮询类 tool_result 已折叠，摘要见前文]';

function truncateMiddle(value: string, maxChars: number): string {
  const clean = stripLoneSurrogates(value);
  if (clean.length <= maxChars) {
    return clean;
  }
  const head = truncateUtf16Units(clean, Math.floor(maxChars / 2)).trimEnd();
  const tail = truncateUtf16UnitsFromEnd(clean, Math.floor(maxChars / 2)).trimStart();
  return `${head}...${tail}`;
}

interface LocatedToolResult {
  messageIndex: number;
  blockIndex: number;
  content: unknown;
}

function locateToolResults(messages: unknown[]): LocatedToolResult[] {
  const found: LocatedToolResult[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex] as Record<string, unknown> | null;
    if (!message || typeof message !== 'object') {
      continue;
    }
    const content = message.content;
    if (Array.isArray(content)) {
      for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
        const block = content[blockIndex] as Record<string, unknown> | null;
        if (block && typeof block === 'object' && String(block.type ?? '') === 'tool_result') {
          found.push({ messageIndex, blockIndex, content: block.content });
        }
      }
    }
  }
  return found;
}

/**
 * Fold low-value polling tool_result blocks in an Anthropic-shaped messages
 * array (the shape the SDK sends to the proxy on resume). Returns a new
 * messages array only when something was folded; otherwise the input array is
 * returned as-is so byte-stable prefixes stay untouched.
 */
export function foldLowValueToolResults(messages: unknown[]): FoldLowValueToolResultsResult {
  const located = locateToolResults(messages);
  const polling = located.filter((entry) => isLowValuePollingToolResult(entry.content));
  const stats: FoldLowValueToolResultsStats = {
    total: polling.length,
    folded: 0,
    kept: 0,
  };

  if (polling.length < LOW_VALUE_TOOL_RESULT_MIN_COUNT) {
    return { messages, stats };
  }

  const foldCount = Math.max(1, polling.length - LOW_VALUE_TOOL_RESULT_KEEP_RECENT);
  const foldTargets = polling.slice(0, foldCount);
  const keptTargets = polling.slice(foldCount);
  stats.folded = foldTargets.length;
  stats.kept = keptTargets.length;

  // Latest folded result's content preview goes into the summary line so the
  // model still sees the last observed state without the repeated noise.
  const latestFolded = foldTargets[foldTargets.length - 1];
  const latestPreview = truncateMiddle(String(latestFolded.content ?? '').replace(/\s+/g, ' ').trim(), 160);
  const summaryText = `[轮询类 tool_result ×${polling.length} 已折叠：最早 ${foldCount} 条状态查询结果压缩为摘要，最近 ${keptTargets.length} 条保留完整。折叠前最新一条：${latestPreview || '(空)'}]`;

  const nextMessages = messages.map((message, messageIndex) => {
    const content = (message as Record<string, unknown> | null)?.content;
    if (!Array.isArray(content)) {
      return message;
    }
    // Rebuild only messages that contain fold targets, keeping every other
    // message reference untouched (byte-stable prefix preservation).
    const targetsHere = foldTargets.filter((entry) => entry.messageIndex === messageIndex);
    if (targetsHere.length === 0) {
      return message;
    }
    const nextBlocks = content.map((block, blockIndex) => {
      const isTarget = targetsHere.some((entry) => entry.blockIndex === blockIndex);
      if (!isTarget) {
        return block;
      }
      const firstFold = targetsHere[0].blockIndex === blockIndex;
      return {
        ...((block as Record<string, unknown>) ?? {}),
        content: firstFold ? summaryText : FOLD_PLACEHOLDER,
      };
    });
    return { ...(message as Record<string, unknown>), content: nextBlocks };
  });

  return { messages: nextMessages, stats };
}
