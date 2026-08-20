import type { CoworkMessage, CoworkMessageType } from '../coworkStore';
import { isDshSessionHandle } from './coworkKernelRouting';

/**
 * Defensive flattening of a Claude Code subagent transcript message into
 * IDBots CoworkMessage[] (user / assistant / tool_use / tool_result).
 *
 * The SDK's getSubagentMessages() returns SessionMessage[] whose `message`
 * field is opaque JSON (the CLI-internal on-disk format, not a typed
 * BetaMessage). In practice:
 * - type 'user' lines carry message.content: string | [tool_result blocks]
 * - type 'assistant' lines carry a full Anthropic message with
 *   content: [thinking | text | tool_use] blocks (+ model-specific extras
 *   such as deepseek reasoning_content that we tolerate and skip)
 *
 * We parse defensively by type/content and never throw on unknown shapes —
 * broken or partial transcripts yield whatever flattened rows are recoverable.
 */

interface TranscriptContentBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  input?: unknown;
  id?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

export function flattenSubagentTranscriptMessages(
  sessionMessages: Array<{
    type: 'user' | 'assistant' | 'system';
    message: unknown;
    parent_tool_use_id: string | null;
  }>
): CoworkMessage[] {
  const result: CoworkMessage[] = [];

  for (const entry of sessionMessages) {
    if (entry.type === 'system') continue;
    const raw = entry.message;
    if (!raw || typeof raw !== 'object') continue;

    const record = raw as Record<string, unknown>;
    const content = record.content;

    if (entry.type === 'user') {
      if (typeof content === 'string') {
        result.push({
          id: `${entry.parent_tool_use_id ?? 'user'}-${result.length}`,
          type: 'user',
          content,
          timestamp: Date.now(),
        });
        continue;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as TranscriptContentBlock;
          if (b.type === 'tool_result') {
            const text = typeof b.content === 'string'
              ? b.content
              : b.content && typeof b.content === 'object' && Array.isArray((b.content as { content?: unknown }).content)
                ? String((b.content as { content: unknown }).content)
                : '';
            result.push({
              id: `tool-result-${result.length}`,
              type: 'tool_result',
              content: text,
              timestamp: Date.now(),
              metadata: {
                toolResult: text,
                toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : null,
                isError: Boolean(b.is_error),
              },
            });
          }
        }
      }
      continue;
    }

    // entry.type === 'assistant'
    const blocks = Array.isArray(content) ? content : [];
    let pendingText = '';

    const flushText = () => {
      if (!pendingText.trim()) return;
      result.push({
        id: `assistant-${result.length}`,
        type: 'assistant',
        content: pendingText,
        timestamp: Date.now(),
      });
      pendingText = '';
    };

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const b = block as TranscriptContentBlock;
      const blockType = String(b.type ?? '');

      if (blockType === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        flushText();
        result.push({
          id: `thinking-${result.length}`,
          type: 'assistant',
          content: b.thinking,
          timestamp: Date.now(),
          metadata: { isThinking: true },
        });
        continue;
      }

      if (blockType === 'text' && typeof b.text === 'string') {
        pendingText += b.text;
        continue;
      }

      if (blockType === 'tool_use') {
        flushText();
        const toolName = String(b.name ?? 'unknown');
        const toolInputRaw = b.input ?? {};
        const toolInput = toolInputRaw && typeof toolInputRaw === 'object'
          ? (toolInputRaw as Record<string, unknown>)
          : { value: toolInputRaw };
        result.push({
          id: `tool-use-${result.length}`,
          type: 'tool_use',
          content: `Using tool: ${toolName}`,
          timestamp: Date.now(),
          metadata: {
            toolName,
            toolInput,
            toolUseId: typeof b.id === 'string' ? b.id : null,
          },
        });
        continue;
      }

      // Unknown block types (e.g. model-specific extras) are tolerated and
      // skipped rather than breaking the transcript render.
    }
    flushText();
  }

  return result;
}

const COWORK_MESSAGE_TYPES = new Set<CoworkMessageType>([
  'user',
  'assistant',
  'tool_use',
  'tool_result',
  'system',
]);

/** True when the session handle belongs to the DSH runtime, not Claude SDK. */
export function sessionUsesDshSubagents(sessionHandle: string | null | undefined): boolean {
  return isDshSessionHandle(sessionHandle);
}

export function mapDshSubagentList(rows: Array<{ agentId: string }>): string[] {
  return rows.map((row) => row.agentId).filter((id) => id.length > 0);
}

export function mapDshSubagentMessages(
  rows: Array<{ id: string; type: string; content: string; timestamp: number }>
): CoworkMessage[] {
  return rows.map((row, index) => ({
    id: row.id || `dsh-subagent-${index}`,
    type: COWORK_MESSAGE_TYPES.has(row.type as CoworkMessageType)
      ? (row.type as CoworkMessageType)
      : 'assistant',
    content: row.content ?? '',
    timestamp: Number.isFinite(row.timestamp) ? row.timestamp : 0,
  }));
}
