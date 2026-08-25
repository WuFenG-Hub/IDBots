/**
 * Reasonix-style tiered tool-result truncation ("snipping") for the CoWork
 * OpenAI-compat proxy.
 *
 * DeepSeek bills prompt tokens with context caching: cache hits are ~10x
 * cheaper, and hits depend on byte-stable request prefixes across turns. When
 * the context estimate crosses the soft threshold, the runner used to flatten
 * the whole history into one synthetic message and reset the SDK session — a
 * full cold start that annihilates the cached prefix. Snipping is the tier
 * before that: stale `tool_result` blocks in the HEAD region of the
 * conversation (everything except a recent tail) are deterministically
 * shortened to a head/marker/tail form, so the SDK session survives and only
 * the prefix bytes after the first newly snipped block change.
 *
 * Determinism is the whole point: for identical (messages, headTokenBudget)
 * inputs the output bytes are identical, so a persisted per-session boundary
 * keeps previously snipped blocks byte-stable across turns and restarts. The
 * boundary is monotonic per session (enforced by the proxy registry), which
 * guarantees a block snipped at boundary B1 stays snipped at boundary B2 > B1.
 *
 * The estimator reuses estimateCoworkTextTokens from coworkContextBudget so a
 * head boundary computed by the runner from budget tokens means the same
 * thing here on the wire messages. Pure module: no I/O, no Electron imports.
 */

import { estimateCoworkTextTokens } from './coworkContextBudget';
import { truncateUtf16Units, truncateUtf16UnitsFromEnd } from './llmSafeText';

/** Marker prefix injected into every snipped tool_result; doubles as the idempotency guard. */
export const COWORK_TOOL_RESULT_SNIP_MARKER = '[snipped tool result';
/** Tool results at or below this many chars are left untouched (the snip overhead would not pay off). */
export const COWORK_TOOL_RESULT_SNIP_MIN_CHARS = 1200;
/** Leading chars kept from the original tool result. */
export const COWORK_TOOL_RESULT_SNIP_HEAD_CHARS = 600;
/** Trailing chars kept from the original tool result. */
export const COWORK_TOOL_RESULT_SNIP_TAIL_CHARS = 300;
/** Runner policy: how many tokens of recent conversation tail are never snipped. */
export const COWORK_TOOL_RESULT_SNIP_TAIL_TOKENS = 24_000;
/** Runner policy hysteresis: a session boundary is only raised in steps of at least this many tokens. */
export const COWORK_TOOL_RESULT_SNIP_HYSTERESIS_TOKENS = 64_000;

/** Anthropic-shaped message as received on /v1/messages (loosely typed: parsed JSON). */
export type AnthropicMessageLike = {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
};

export interface ToolResultSnipStats {
  /** tool_result blocks rewritten in the head region. */
  snippedBlocks: number;
  /** Estimated tokens removed by the rewrites (original estimate minus snipped estimate). */
  savedTokens: number;
  /** Estimated tokens of the whole input message array, pre-snip. */
  estimatedTokens: number;
}

export interface ToolResultSnipResult {
  messages: AnthropicMessageLike[];
  stats: ToolResultSnipStats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Text content of a tool_result block: the string form, or the joined text parts of the array form. */
export function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function serializeBlockForEstimate(block: Record<string, unknown>): string {
  const type = typeof block.type === 'string' ? block.type : '';
  if (type === 'text') {
    return typeof block.text === 'string' ? block.text : '';
  }
  if (type === 'tool_result') {
    return extractToolResultText(block.content);
  }
  if (type === 'image' || type === 'document') {
    // Binary payloads are never snipped and are counted only loosely; a fixed
    // placeholder keeps the estimate deterministic without walking base64 data.
    return `[${type}]`;
  }
  try {
    return JSON.stringify(block) ?? '';
  } catch {
    return '';
  }
}

/** Estimated tokens of one Anthropic `content` value (string or block array). */
export function estimateAnthropicContentTokens(content: unknown): number {
  if (typeof content === 'string') {
    return estimateCoworkTextTokens(content);
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let total = 0;
  for (const block of content) {
    if (isRecord(block)) {
      total += estimateCoworkTextTokens(serializeBlockForEstimate(block));
    }
  }
  return total;
}

function shouldSnipText(text: string): boolean {
  return text.length > COWORK_TOOL_RESULT_SNIP_MIN_CHARS && !text.includes(COWORK_TOOL_RESULT_SNIP_MARKER);
}

function buildSnippedText(text: string): string {
  // Surrogate-safe cuts: a head/tail slicing through an emoji pair would
  // strand a lone surrogate in the rewired message — corrupting the very
  // request bytes snipping is meant to keep stable (and 400'ing strict
  // upstream JSON parsers). Identical inputs still produce identical bytes.
  const head = truncateUtf16Units(text, COWORK_TOOL_RESULT_SNIP_HEAD_CHARS);
  const tail = truncateUtf16UnitsFromEnd(text, COWORK_TOOL_RESULT_SNIP_TAIL_CHARS);
  const omitted = text.slice(head.length, text.length - tail.length);
  const omittedBytes = Buffer.byteLength(omitted, 'utf8');
  return `${head}\n${COWORK_TOOL_RESULT_SNIP_MARKER} — ${omittedBytes} bytes omitted; re-read or re-run if needed]\n${tail}`;
}

/**
 * Snip one tool_result block's text content. Returns the rewritten block, or
 * null when nothing changed. `tool_use_id`, `is_error`, and every other block
 * field are preserved untouched; image/document parts are never modified.
 */
function snipToolResultBlock(
  block: Record<string, unknown>,
  stats: ToolResultSnipStats
): Record<string, unknown> | null {
  const content = block.content;
  if (typeof content === 'string') {
    if (!shouldSnipText(content)) {
      return null;
    }
    const snipped = buildSnippedText(content);
    stats.snippedBlocks += 1;
    stats.savedTokens += Math.max(0, estimateCoworkTextTokens(content) - estimateCoworkTextTokens(snipped));
    return { ...block, content: snipped };
  }
  if (Array.isArray(content)) {
    let changed = false;
    let savedTokens = 0;
    const newContent = content.map((part) => {
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string' && shouldSnipText(part.text)) {
        const snipped = buildSnippedText(part.text);
        savedTokens += Math.max(0, estimateCoworkTextTokens(part.text) - estimateCoworkTextTokens(snipped));
        changed = true;
        return { ...part, text: snipped };
      }
      return part;
    });
    if (!changed) {
      return null;
    }
    stats.snippedBlocks += 1;
    stats.savedTokens += savedTokens;
    return { ...block, content: newContent };
  }
  return null;
}

/**
 * Walk messages front to back; while the accumulated estimated tokens stay
 * within `headTokenBudget`, rewrite stale tool_result blocks to their
 * head/marker/tail form. A message whose own tokens would cross the boundary
 * is left fully intact (conservative: snip less, never into the tail).
 *
 * Never mutates the input: unchanged messages keep object identity, changed
 * messages/blocks are shallow copies. Message order and tool_use/tool_result
 * pairing are preserved (blocks are only ever shortened in place, never
 * added, removed, reordered, or re-keyed) so strict providers keep accepting
 * the request. Idempotent: blocks already carrying the snip marker are
 * skipped, so applying the same boundary twice yields identical bytes.
 */
export function snipStaleToolResultBlocks(
  messages: unknown,
  headTokenBudget: number
): ToolResultSnipResult {
  const stats: ToolResultSnipStats = { snippedBlocks: 0, savedTokens: 0, estimatedTokens: 0 };
  if (!Array.isArray(messages)) {
    return { messages: [], stats };
  }
  const headBudget = Number.isFinite(headTokenBudget) ? Math.max(0, Math.floor(headTokenBudget)) : 0;
  let accumulatedTokens = 0;
  const resultMessages: AnthropicMessageLike[] = [];

  for (const message of messages as unknown[]) {
    if (!isRecord(message)) {
      resultMessages.push(message as AnthropicMessageLike);
      continue;
    }
    const messageTokens = estimateAnthropicContentTokens(message.content);
    stats.estimatedTokens += messageTokens;
    accumulatedTokens += messageTokens;
    if (accumulatedTokens > headBudget || !Array.isArray(message.content)) {
      resultMessages.push(message);
      continue;
    }
    let changed = false;
    const newBlocks = (message.content as unknown[]).map((block) => {
      if (isRecord(block) && block.type === 'tool_result') {
        const snipped = snipToolResultBlock(block, stats);
        if (snipped) {
          changed = true;
          return snipped;
        }
      }
      return block;
    });
    resultMessages.push(changed ? { ...message, content: newBlocks } : message);
  }

  return { messages: resultMessages, stats };
}
