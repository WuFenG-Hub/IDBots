import type { CoworkMessage } from '../types/cowork';
import { isRenderableAssistantOrSystemMessage } from '../utils/coworkMessageVisibility';

const DELEGATION_CONTROL_PREFIX = '[DELEGATE_REMOTE_SERVICE]';

export type ToolGroupItem = {
  type: 'tool_group';
  toolUse: CoworkMessage;
  toolResult?: CoworkMessage | null;
};

export type DisplayItem =
  | { type: 'message'; message: CoworkMessage }
  | ToolGroupItem;

export type AssistantTurnItem =
  | { type: 'assistant'; message: CoworkMessage }
  | { type: 'system'; message: CoworkMessage }
  | { type: 'tool_group'; group: ToolGroupItem }
  | { type: 'tool_result'; message: CoworkMessage };

export type ConversationTurn = {
  id: string;
  userMessage: CoworkMessage | null;
  assistantItems: AssistantTurnItem[];
};

const hasText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const getToolResultDisplay = (message: CoworkMessage): string => {
  if (hasText(message.content)) {
    return message.content;
  }
  if (hasText(message.metadata?.toolResult)) {
    return message.metadata?.toolResult ?? '';
  }
  if (hasText(message.metadata?.error)) {
    return message.metadata?.error ?? '';
  }
  return '';
};

const isA2ATransportHandshakeMessage = (message: CoworkMessage): boolean => {
  const isMetawebPrivate = message.metadata?.sourceChannel === 'metaweb_private';
  if (!isMetawebPrivate) {
    return false;
  }
  const normalizedContent = typeof message.content === 'string'
    ? message.content.trim().toLowerCase().replace(/[^a-z]/g, '')
    : '';
  return normalizedContent === 'ping' || normalizedContent === 'pong';
};

export const shouldHideControlMessage = (message: CoworkMessage): boolean => {
  if (isA2ATransportHandshakeMessage(message)) {
    return true;
  }
  if (message.metadata?.isDelegationInternal) {
    return true;
  }
  // Ephemeral SDK runtime-status signals (api_retry / requesting) are surfaced
  // in professional mode's above-composer StreamingActivityBar, not as
  // persisted message bubbles. Assistant mode hides them here too; its single
  // inline activity indicator derives status from the turn's own messages.
  if (typeof message.metadata?.sdkRuntimeStatus === 'string') {
    return true;
  }
  // Prompt-suggestion signals are surfaced as chips below the prompt input.
  if (typeof message.metadata?.promptSuggestion === 'string') {
    return true;
  }
  // Subagent activity signals drive the live subagent panel, not the message list.
  if (message.metadata?.subagentEvent && typeof message.metadata.subagentEvent === 'object') {
    return true;
  }
  return typeof message.content === 'string' && message.content.includes(DELEGATION_CONTROL_PREFIX);
};

export const buildDisplayItems = (messages: CoworkMessage[]): DisplayItem[] => {
  const items: DisplayItem[] = [];
  const groupsByToolUseId = new Map<string, ToolGroupItem>();
  let pendingAdjacentGroup: ToolGroupItem | null = null;

  for (const message of messages) {
    if (shouldHideControlMessage(message)) {
      continue;
    }

    if (message.type === 'tool_use') {
      const group: ToolGroupItem = { type: 'tool_group', toolUse: message };
      items.push(group);

      const toolUseId = message.metadata?.toolUseId;
      if (typeof toolUseId === 'string' && toolUseId.trim()) {
        groupsByToolUseId.set(toolUseId, group);
      }
      pendingAdjacentGroup = group;
      continue;
    }

    if (message.type === 'tool_result') {
      let matched = false;
      const toolUseId = message.metadata?.toolUseId;
      if (typeof toolUseId === 'string' && groupsByToolUseId.has(toolUseId)) {
        const group = groupsByToolUseId.get(toolUseId);
        if (group) {
          group.toolResult = message;
          matched = true;
        }
      } else if (pendingAdjacentGroup && !pendingAdjacentGroup.toolResult) {
        pendingAdjacentGroup.toolResult = message;
        matched = true;
      }

      pendingAdjacentGroup = null;
      if (!matched) {
        items.push({ type: 'message', message });
      }
      continue;
    }

    pendingAdjacentGroup = null;
    items.push({ type: 'message', message });
  }

  return items;
};

export const buildConversationTurns = (items: DisplayItem[]): ConversationTurn[] => {
  const turns: ConversationTurn[] = [];
  let currentTurn: ConversationTurn | null = null;
  let orphanIndex = 0;

  const ensureTurn = (): ConversationTurn => {
    if (currentTurn) return currentTurn;
    const orphanTurn: ConversationTurn = {
      id: `orphan-${orphanIndex++}`,
      userMessage: null,
      assistantItems: [],
    };
    turns.push(orphanTurn);
    currentTurn = orphanTurn;
    return orphanTurn;
  };

  for (const item of items) {
    if (item.type === 'message' && item.message.type === 'user') {
      currentTurn = {
        id: item.message.id,
        userMessage: item.message,
        assistantItems: [],
      };
      turns.push(currentTurn);
      continue;
    }

    const turn = ensureTurn();
    if (item.type === 'tool_group') {
      turn.assistantItems.push({ type: 'tool_group', group: item });
      continue;
    }

    const message = item.message;
    if (message.type === 'assistant') {
      turn.assistantItems.push({ type: 'assistant', message });
      continue;
    }

    if (message.type === 'system') {
      turn.assistantItems.push({ type: 'system', message });
      continue;
    }

    if (message.type === 'tool_result') {
      turn.assistantItems.push({ type: 'tool_result', message });
      continue;
    }

    if (message.type === 'tool_use') {
      turn.assistantItems.push({
        type: 'tool_group',
        group: {
          type: 'tool_group',
          toolUse: message,
        },
      });
    }
  }

  return turns;
};

export const isVisibleAssistantTurnItem = (item: AssistantTurnItem, isAssistantMode = false): boolean => {
  // Assistant mode hides all tool-call chrome (render-only filtering — the
  // underlying messages stay intact, so switching back to professional mode
  // restores the full transcript).
  if (isAssistantMode && (item.type === 'tool_group' || item.type === 'tool_result')) {
    return false;
  }
  // Assistant mode never surfaces raw reasoning: thinking items stay out of
  // the transcript entirely. Explicit owner_update progress arrives as
  // ordinary chat messages (metadata.narration) instead.
  if (isAssistantMode && item.type === 'assistant' && item.message.metadata?.isThinking) {
    return false;
  }
  if (item.type === 'assistant' || item.type === 'system') {
    return isRenderableAssistantOrSystemMessage(item.message);
  }
  if (item.type === 'tool_result') {
    return hasText(getToolResultDisplay(item.message));
  }
  return true;
};

export const getVisibleAssistantItems = (assistantItems: AssistantTurnItem[], isAssistantMode = false): AssistantTurnItem[] =>
  assistantItems.filter((item) => isVisibleAssistantTurnItem(item, isAssistantMode));

export const hasRenderableAssistantContent = (turn: ConversationTurn, isAssistantMode = false): boolean => (
  getVisibleAssistantItems(turn.assistantItems, isAssistantMode).length > 0
);
