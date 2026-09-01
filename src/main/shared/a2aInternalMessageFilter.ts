/**
 * A2A session message visibility.
 *
 * Private A2A conversations are mostly bot-to-bot chatter that humans rarely
 * read, so internal states (reasoning, tool calls, internal system notices)
 * are hidden unless they belong to a service-order flow. Order-related
 * internal states stay visible so paid skill executions remain traceable.
 *
 * Shared by the renderer (bubble list) and the main-process session pager so
 * A2A history windows skip hidden tails instead of rendering a blank page.
 */

const ORDER_PROTOCOL_CONTENT_RE = /^\s*\[(ORDER|ORDER_STATUS|DELIVERY|NeedsRating|ORDER_END)\b/i;

export type A2AFilterableMessage = {
  type?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
};

const readMetadata = (message: A2AFilterableMessage): Record<string, unknown> => (
  message.metadata && typeof message.metadata === 'object' ? message.metadata : {}
);

/** Metadata keys that mark a message as part of a skillservice order flow. */
export const isA2AOrderRelatedMessage = (message: A2AFilterableMessage): boolean => {
  const metadata = readMetadata(message);
  if (
    metadata.orderMappingExternalConversationId
    || metadata.orderExecutionTrace === true
    || metadata.simplemsgKind === 'order_protocol'
    || metadata.serviceOrderEvent
    || metadata.orderDeliveryUploadNotice === true
    || metadata.orderTxid
    || metadata.orderMessageTxid
    || metadata.serviceOrderPinId
    || metadata.orderPinId
    || metadata.orderId
    || metadata.paymentTxid
    || metadata.orderPaymentTxid
  ) {
    return true;
  }
  const content = typeof message.content === 'string' ? message.content : '';
  return ORDER_PROTOCOL_CONTENT_RE.test(content);
};

/**
 * Hide non-order internal states in A2A sessions: tool calls (Bash/Read/…),
 * internal reasoning (isThinking) and internal system notices. Conversation
 * bubbles (messages delivered on-chain, or local notices like the end-of-
 * conversation marker and failed-delivery retries) stay visible.
 */
export const shouldHideA2AInternalMessage = (message: A2AFilterableMessage): boolean => {
  if (isA2AOrderRelatedMessage(message)) return false;
  if (message.type === 'tool_use' || message.type === 'tool_result') return true;
  if (message.type === 'system') return true;
  if (readMetadata(message).isThinking === true) return true;
  return false;
};

/** In-flight local work that the activity bar still needs even when bubbles hide it. */
export const isA2ALiveWorkMessage = (message: A2AFilterableMessage): boolean => {
  if (isA2AOrderRelatedMessage(message)) return false;
  if (message.type === 'tool_use' || message.type === 'tool_result') return true;
  const metadata = readMetadata(message);
  if (metadata.isThinking === true) return true;
  return typeof metadata.sdkRuntimeStatus === 'string';
};

export const isA2ASystemErrorMessage = (message: A2AFilterableMessage): boolean => {
  if (message.type !== 'system') return false;
  const metadata = readMetadata(message);
  if (typeof metadata.error === 'string' && metadata.error.trim()) return true;
  const content = typeof message.content === 'string' ? message.content : '';
  return /^\s*Error:/i.test(content) || metadata.isError === true;
};

/**
 * Human-readable cause behind an A2A session's error status: the newest
 * system error message in the transcript, preferring metadata.error over the
 * "Error: …" content. System bubbles are hidden in the A2A view, so the error
 * banner is the only place this text can surface. Returns null when the loaded
 * message window contains no error message.
 */
export const lastA2AErrorDetail = (
  messages: Array<A2AFilterableMessage>,
  maxChars: number = 240,
): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || !isA2ASystemErrorMessage(message)) continue;
    const metadata = readMetadata(message);
    const metadataError = typeof metadata.error === 'string' ? metadata.error.trim() : '';
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    const detail = metadataError
      || content.replace(/^\s*Error:\s*/i, '').trim();
    if (!detail) continue;
    return detail.length > maxChars ? `${detail.slice(0, maxChars - 1)}…` : detail;
  }
  return null;
};
