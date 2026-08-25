import type { CoworkMessage } from '../coworkStore';
import type { CoworkModelLimits } from './coworkModelLimits';
import {
  estimateCoworkTextTokens,
  shouldIncludeCoworkContextMessage,
} from './coworkContextBudget';
import { truncateUtf16Units } from './llmSafeText';

const DEFAULT_RECENT_MESSAGES = 16;
const DEFAULT_SUMMARY_CHARS = 12_000;
const DEFAULT_RECENT_TAIL_TOKENS = 24_000;
const MESSAGE_CONTENT_MAX_CHARS = 4_000;

export interface BuildCoworkCompactedPromptInput {
  messages: CoworkMessage[];
  currentPrompt: string;
  modelLimits: Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens'>;
  maxRecentMessages?: number;
  maxSummaryChars?: number;
  maxRecentTailTokens?: number;
}

export interface CoworkCompactedPrompt {
  prompt: string;
  estimatedTokens: number;
  recentMessages: number;
  summarizedMessages: number;
}

function normalizeContent(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 16) {
    return truncateUtf16Units(value, Math.max(0, maxChars));
  }
  return `${truncateUtf16Units(value, maxChars - 16).trimEnd()}... [truncated]`;
}

function toKbLabel(charCount: number): string {
  return `约 ${Math.max(1, Math.round(charCount / 1024))}KB`;
}

interface ExtractedImageInfo {
  fileName?: string;
  mediaType?: string;
  charCount: number;
}

function extractImageInfoFromValue(value: unknown, into: ExtractedImageInfo[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      extractImageInfoFromValue(item, into);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  if (type === 'image' || type === 'image_url') {
    const source = record.source && typeof record.source === 'object'
      ? (record.source as Record<string, unknown>)
      : record;
    const imageUrlObj = record.image_url && typeof record.image_url === 'object'
      ? (record.image_url as Record<string, unknown>)
      : null;
    const urlValue = typeof source.url === 'string'
      ? source.url
      : (typeof record.url === 'string' ? record.url : (typeof imageUrlObj?.url === 'string' ? imageUrlObj.url : undefined));
    const dataUriMime = urlValue ? (urlValue.match(/^data:([^;,]+)/i)?.[1] ?? undefined) : undefined;
    const mediaType = typeof source.media_type === 'string'
      ? source.media_type
      : (typeof record.media_type === 'string' ? record.media_type : dataUriMime);
    const fileName = typeof source.file_name === 'string'
      ? source.file_name
      : (typeof record.file_name === 'string' ? record.file_name : undefined);
    let charCount = 0;
    if (typeof source.data === 'string') {
      charCount = source.data.length;
    } else if (urlValue) {
      charCount = urlValue.length;
    }
    into.push({ fileName, mediaType, charCount });
    return;
  }
  // Recurse into the remaining fields (tool_result containers wrap image
  // blocks inside content arrays with extra fields like tool_use_id).
  for (const key of ['content', 'source', 'image_url']) {
    if (key in record) {
      extractImageInfoFromValue(record[key], into);
    }
  }
}

/**
 * GT#12 N6: turn a message content that embeds image blocks into a semantic
 * one-line placeholder instead of truncating raw base64 into the compact
 * summary. Returns null when the content carries no image blocks, so plain
 * text messages keep their previous behavior exactly.
 */
export function describeImageContent(content: string): string | null {
  if (!content) {
    return null;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }

  const images: ExtractedImageInfo[] = [];
  if (parsed !== null) {
    extractImageInfoFromValue(parsed, images);
  }

  if (images.length === 0) {
    // Not valid JSON: fall back to a structural pattern check so base64 that
    // survived stringification is still caught.
    if (!/"type"\s*:\s*"image"/i.test(content)) {
      return null;
    }
    const dataMatch = content.match(/"data"\s*:\s*"([^"]+)"/i);
    return `[图片块：${dataMatch ? toKbLabel(dataMatch[1].length) : toKbLabel(content.length)}，内容已省略]`;
  }

  const lines: string[] = [];
  for (const image of images) {
    const parts: string[] = [];
    if (image.fileName) {
      parts.push(`文件名 ${image.fileName}`);
    }
    if (image.mediaType) {
      parts.push(image.mediaType);
    }
    parts.push(image.charCount > 0 ? `base64 ${toKbLabel(image.charCount)}` : 'base64 长度未知');
    lines.push(`[图片: ${parts.join('，')}，已省略]`);
  }
  return lines.join(' ');
}

function roleLabel(message: Pick<CoworkMessage, 'type' | 'metadata'>): string {
  if (message.type === 'tool_use') {
    const toolName = typeof message.metadata?.toolName === 'string' ? message.metadata.toolName : 'tool';
    return `tool_use:${toolName}`;
  }
  if (message.type === 'tool_result') {
    const toolName = typeof message.metadata?.toolName === 'string' ? message.metadata.toolName : 'tool';
    return `tool_result:${toolName}`;
  }
  return message.type;
}

function formatMessageLine(message: CoworkMessage, maxChars = MESSAGE_CONTENT_MAX_CHARS): string {
  // GT#12 N6: image blocks become semantic placeholders in the compact
  // summary — truncating raw base64 JSON was pure garbage with no signal.
  const imageSummary = describeImageContent(message.content);
  const content = imageSummary ?? truncateText(normalizeContent(message.content), maxChars);
  return `- ${roleLabel(message)}: ${content}`;
}

function filterHistory(messages: CoworkMessage[], currentPrompt: string): CoworkMessage[] {
  const trimmedPrompt = currentPrompt.trim();
  const filteredFromNewest: CoworkMessage[] = [];
  let removedCurrentPrompt = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!shouldIncludeCoworkContextMessage(message)) {
      continue;
    }
    if (
      !removedCurrentPrompt
      && trimmedPrompt
      && message.type === 'user'
      && message.content.trim() === trimmedPrompt
    ) {
      removedCurrentPrompt = true;
      continue;
    }
    filteredFromNewest.push(message);
  }

  return filteredFromNewest.reverse();
}

function selectRecentTail(
  history: CoworkMessage[],
  maxRecentMessages: number,
  maxRecentTailTokens: number
): { recent: CoworkMessage[]; firstRecentIndex: number } {
  const selectedFromNewest: CoworkMessage[] = [];
  let totalTokens = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (selectedFromNewest.length >= maxRecentMessages) {
      break;
    }
    const message = history[index];
    const messageTokens = estimateCoworkTextTokens(formatMessageLine(message));
    if (totalTokens + messageTokens > maxRecentTailTokens) {
      if (selectedFromNewest.length === 0) {
        selectedFromNewest.push(message);
      }
      break;
    }
    selectedFromNewest.push(message);
    totalTokens += messageTokens;
  }

  const recent = selectedFromNewest.reverse();
  const firstRecent = recent[0];
  const firstRecentIndex = firstRecent ? history.findIndex((message) => message.id === firstRecent.id) : history.length;
  return {
    recent,
    firstRecentIndex: firstRecentIndex >= 0 ? firstRecentIndex : history.length,
  };
}

function buildSummaryLines(messages: CoworkMessage[], maxSummaryChars: number): string {
  if (messages.length === 0) {
    return '- No earlier messages outside the recent tail.';
  }

  const lines: string[] = [];
  let totalChars = 0;
  let omitted = 0;

  for (const message of messages) {
    const line = formatMessageLine(message, 800);
    const nextTotal = totalChars + line.length + 1;
    if (nextTotal > maxSummaryChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    totalChars = nextTotal;
  }

  if (omitted > 0) {
    lines.push(`- ... [truncated ${omitted} earlier message(s)]`);
  }

  return lines.length > 0 ? lines.join('\n') : `- ... [truncated ${messages.length} earlier message(s)]`;
}

function buildRecentTailLines(messages: CoworkMessage[], maxRecentTailTokens: number): string {
  if (messages.length === 0) {
    return '- No recent messages are available.';
  }

  const maxCharsPerMessage = Math.max(200, Math.floor((maxRecentTailTokens * 4) / Math.max(1, messages.length)));
  return messages
    .map((message) => formatMessageLine(message, Math.min(MESSAGE_CONTENT_MAX_CHARS, maxCharsPerMessage)))
    .join('\n');
}

export function buildCoworkCompactedPrompt(input: BuildCoworkCompactedPromptInput): CoworkCompactedPrompt {
  const usableInputTokens = Math.max(1, input.modelLimits.contextWindow - input.modelLimits.maxOutputTokens);
  const maxRecentMessages = Math.max(1, Math.floor(input.maxRecentMessages ?? DEFAULT_RECENT_MESSAGES));
  const maxSummaryChars = Math.max(80, Math.floor(input.maxSummaryChars ?? Math.min(DEFAULT_SUMMARY_CHARS, usableInputTokens)));
  const maxRecentTailTokens = Math.max(
    16,
    Math.floor(input.maxRecentTailTokens ?? Math.min(DEFAULT_RECENT_TAIL_TOKENS, Math.floor(usableInputTokens * 0.35)))
  );

  const history = filterHistory(input.messages, input.currentPrompt);
  const { recent, firstRecentIndex } = selectRecentTail(history, maxRecentMessages, maxRecentTailTokens);
  const summaryMessages = history.slice(0, firstRecentIndex);

  const summary = buildSummaryLines(summaryMessages, maxSummaryChars);
  const recentTail = buildRecentTailLines(recent, maxRecentTailTokens);
  const currentRequest = input.currentPrompt.trim() || '(empty current request)';

  const prompt = [
    '[IDBots compacted cowork context]',
    'The underlying SDK conversation was reset because the prior session approached or exceeded the model context window.',
    'Use only the compacted summary, recent tail, and current request below. Do not assume hidden access to the old SDK session.',
    '',
    '<session_summary>',
    summary,
    '</session_summary>',
    '',
    '<recent_tail>',
    recentTail,
    '</recent_tail>',
    '',
    '<current_user_request>',
    currentRequest,
    '</current_user_request>',
  ].join('\n');

  return {
    prompt,
    estimatedTokens: estimateCoworkTextTokens(prompt),
    recentMessages: recent.length,
    summarizedMessages: summaryMessages.length,
  };
}
