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
const TXID_RE = /^[0-9a-f]{64}$/i;
const PIN_ID_TXID_RE = /^([0-9a-f]{64})i\d+$/i;

export type A2AFilterableMessage = {
  type?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
};

const readMetadata = (message: A2AFilterableMessage): Record<string, unknown> => (
  message.metadata && typeof message.metadata === 'object' ? message.metadata : {}
);

const normalizePinIdCandidate = (value: unknown): string => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const match = normalized.match(PIN_ID_TXID_RE);
  return match?.[1] ?? '';
};

export const normalizeTxidCandidate = (value: unknown): string => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return TXID_RE.test(normalized) ? normalized : '';
};

/**
 * Resolve the on-chain txid a conversation bubble anchors to. Shared by the
 * renderer bubble renderer and this filter so both agree on which messages
 * were delivered on-chain: a message that resolves here renders as a normal
 * bubble; an assistant message that resolves to nothing is internal state.
 */
export const resolveA2AMessageTxid = (message: A2AFilterableMessage): string => {
  const metadata = readMetadata(message);
  const txidsCandidate = Array.isArray(metadata.txids)
    ? metadata.txids.map(normalizeTxidCandidate).find(Boolean)
    : '';
  const directCandidate = [
    metadata.txid,
    metadata.messageTxid,
    metadata.pinTxid,
    metadata.deliveryTxid,
    metadata.deliveryMessageTxid,
    metadata.orderMessageTxid,
  ].map(normalizeTxidCandidate).find(Boolean);
  if (txidsCandidate) return txidsCandidate;
  if (directCandidate) return directCandidate;

  const pinCandidate = [
    metadata.pinId,
    metadata.messagePinId,
    metadata.deliveryPinId,
    metadata.deliveryMessagePinId,
    metadata.orderMessagePinId,
    metadata.refundRequestPinId,
    metadata.refundFinalizePinId,
  ].map(normalizePinIdCandidate).find(Boolean);
  if (pinCandidate) return pinCandidate;

  return '';
};

export const formatA2ATxidPreview = (txid: string): string => {
  const normalized = normalizeTxidCandidate(txid);
  return normalized ? `${normalized.slice(0, 8)}....` : '';
};

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
 * Session-level context for the hide decision. `chainBackedConversation` marks
 * a conversation whose replies are delivered over the on-chain metaweb_private
 * channel: every delivered reply gets a txid patched into its metadata after
 * broadcast, so an assistant message without any resolvable txid there is
 * intermediate monologue between tool calls. Owner-facing local turns (weather
 * answers, artifact handoffs in autonomous task sessions) never broadcast, so
 * the txid rule must not apply to them.
 */
export type A2AHideContext = {
  chainBackedConversation?: boolean;
};

/**
 * Hide non-order internal states in A2A sessions: tool calls (Bash/Read/…),
 * internal reasoning (isThinking), internal system notices, no-reply
 * sentinel bubbles (the bot chose silence — nothing was delivered on-chain),
 * and — in chain-backed conversations — assistant monologue that never
 * reached the chain (no resolvable txid). Conversation bubbles (messages
 * delivered on-chain, or local notices like the end-of-conversation marker
 * and failed-delivery retries) stay visible. Order-flow messages keep their
 * traceability regardless of txid presence.
 */
export const shouldHideA2AInternalMessage = (
  message: A2AFilterableMessage,
  context?: A2AHideContext,
): boolean => {
  if (isA2AOrderRelatedMessage(message)) return false;
  if (message.type === 'tool_use' || message.type === 'tool_result') return true;
  if (message.type === 'system') return true;
  const metadata = readMetadata(message);
  if (metadata.isThinking === true) return true;
  if (metadata.privateChatNoReply === true) return true;
  if (
    context?.chainBackedConversation === true
    && message.type === 'assistant'
    && !resolveA2AMessageTxid(message)
  ) {
    return true;
  }
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
