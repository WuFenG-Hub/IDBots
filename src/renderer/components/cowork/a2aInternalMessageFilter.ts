import type { CoworkMessage } from '../../types/cowork';

/**
 * A2A session message visibility.
 *
 * Private A2A conversations are mostly bot-to-bot chatter that humans rarely
 * read, so internal states (reasoning, tool calls, internal system notices)
 * are hidden unless they belong to a service-order flow. Order-related
 * internal states stay visible so paid skill executions remain traceable.
 */

const ORDER_PROTOCOL_CONTENT_RE = /^\s*\[(ORDER|ORDER_STATUS|DELIVERY|NeedsRating|ORDER_END)\b/i;

/** Metadata keys that mark a message as part of a skillservice order flow. */
export const isA2AOrderRelatedMessage = (message: CoworkMessage): boolean => {
  const metadata = message.metadata ?? {};
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
export const shouldHideA2AInternalMessage = (message: CoworkMessage): boolean => {
  if (isA2AOrderRelatedMessage(message)) return false;
  if (message.type === 'tool_use' || message.type === 'tool_result') return true;
  if (message.type === 'system') return true;
  if (message.metadata?.isThinking === true) return true;
  return false;
};
