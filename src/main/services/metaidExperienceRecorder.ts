import { createHash } from 'node:crypto';
import type {
  MetaIDExperienceStore,
  MetaIDExperienceEpisode,
  MetaIDExperienceEvidence,
} from '../metaidExperienceStore';
import type { ServiceOrderRecord } from '../serviceOrderStore';
import { normalizeGlobalMetaID } from '../shared/globalMetaId';
import type { ServiceOrderExperienceEventType } from './serviceOrderLifecycleService';

export type MetaIDPrivateA2ADirection = 'incoming' | 'outgoing';

export interface RecordMetaIDPrivateA2AExperienceInput {
  store: MetaIDExperienceStore;
  ownerGlobalMetaID: unknown;
  peerGlobalMetaID: unknown;
  externalConversationId: string;
  sessionId?: string | null;
  direction: MetaIDPrivateA2ADirection;
  content: string;
  messageId?: string | null;
  pinId?: string | null;
  replyToPinId?: string | null;
  occurredAt?: number | null;
  sourceMetadata?: Record<string, unknown>;
}

export interface RecordMetaIDPrivateA2AExperienceResult {
  episode: MetaIDExperienceEpisode;
  evidence: MetaIDExperienceEvidence;
}

export type MetaIDServiceOrderExperienceEvent = ServiceOrderExperienceEventType;

export interface RecordMetaIDServiceOrderExperienceInput {
  store: MetaIDExperienceStore;
  ownerGlobalMetaID: unknown;
  order: ServiceOrderRecord;
  event: MetaIDServiceOrderExperienceEvent;
  occurredAt?: number | null;
  sourceMetadata?: Record<string, unknown>;
}

export interface RecordMetaIDServiceOrderExperienceResult {
  episode: MetaIDExperienceEpisode;
  evidence: MetaIDExperienceEvidence;
}

export interface MetaIDGroupTaskParticipantInput {
  globalMetaID?: unknown;
  unresolvedActorKey?: string | null;
  role?: string | null;
}

export interface RecordMetaIDGroupTaskExperienceInput {
  store: MetaIDExperienceStore;
  ownerGlobalMetaID: unknown;
  taskId: string | number;
  groupId?: string | null;
  sessionId?: string | null;
  message: {
    id: string | number;
    pinId?: string | null;
    txId?: string | null;
    senderGlobalMetaID?: unknown;
    senderMetaID?: string | null;
    content: string;
    occurredAt?: number | null;
    replyPin?: string | null;
  };
  participants?: MetaIDGroupTaskParticipantInput[];
}

const handshakeText = new Set(['ping', 'pong']);

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function identifier(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  return text(value);
}

function isNoOpPrivateChatText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return !normalized
    || handshakeText.has(normalized)
    || normalized === 'bye'
    || normalized === 'thinking...'
    || normalized === 'thinking…'
    || /^[.\s]+$/.test(normalized)
    || /^[…\s]+$/.test(normalized);
}

function hashContent(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function asTimestamp(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  // MetaWeb chain timestamps are epoch seconds; local SQLite lifecycle times
  // are epoch milliseconds. Normalize the former at the cognition boundary.
  return Math.floor(parsed > 0 && parsed < 1_000_000_000_000 ? parsed * 1000 : parsed);
}

/**
 * Record one meaningful private A2A turn without storing the raw private text
 * a second time. The caller owns failure isolation: a cognition write must not
 * block message delivery.
 */
export function recordMetaIDPrivateA2AExperience(
  input: RecordMetaIDPrivateA2AExperienceInput,
): RecordMetaIDPrivateA2AExperienceResult | null {
  const ownerGlobalMetaID = normalizeGlobalMetaID(input.ownerGlobalMetaID);
  const peerGlobalMetaID = normalizeGlobalMetaID(input.peerGlobalMetaID);
  const content = text(input.content);
  const externalConversationId = text(input.externalConversationId);
  if (!ownerGlobalMetaID || !peerGlobalMetaID || ownerGlobalMetaID === peerGlobalMetaID) return null;
  if (!externalConversationId || isNoOpPrivateChatText(content)) return null;

  const conversationKey = `a2a:${externalConversationId}`;
  const messageIdentity = input.direction === 'outgoing' && text(input.replyToPinId)
    ? `reply:${text(input.replyToPinId)}`
    : `message:${text(input.pinId) || text(input.messageId)}`;
  if (messageIdentity === 'message:') return null;

  const now = Date.now();
  const episodeResult = input.store.createEpisode({
    ownerGlobalMetaID,
    episodeType: 'direct_interaction',
    sourceChannel: 'metaweb_private',
    sourceKey: conversationKey,
    sessionId: text(input.sessionId) || null,
    externalConversationId,
    status: 'open',
    startedAt: asTimestamp(input.occurredAt) ?? now,
    metadata: {
      interaction: 'private_a2a',
      ...(input.sourceMetadata ?? {}),
    },
  });

  input.store.addParticipant({
    episodeId: episodeResult.episode.id,
    globalMetaID: ownerGlobalMetaID,
    role: input.direction === 'incoming' ? 'recipient' : 'sender',
    source: 'private_chat_local_identity',
  });
  input.store.addParticipant({
    episodeId: episodeResult.episode.id,
    globalMetaID: peerGlobalMetaID,
    role: input.direction === 'incoming' ? 'sender' : 'recipient',
    source: 'private_chat_peer_identity',
  });

  const evidence = input.store.addEvidence({
    episodeId: episodeResult.episode.id,
    evidenceType: 'message',
    sourceKey: messageIdentity,
    pinId: text(input.pinId) || null,
    publisherGlobalMetaID: input.direction === 'incoming' ? peerGlobalMetaID : ownerGlobalMetaID,
    messageId: text(input.messageId) || null,
    contentHash: hashContent(content),
    occurredAt: asTimestamp(input.occurredAt) ?? now,
    metadata: {
      direction: input.direction,
      externalConversationId,
      ...(input.sourceMetadata ?? {}),
    },
  });

  return { episode: episodeResult.episode, evidence };
}

function serviceOrderEpisodeStatus(order: ServiceOrderRecord): 'open' | 'completed' | 'failed' {
  if (order.status === 'completed' || order.status === 'refunded') return 'completed';
  if (order.status === 'failed') return 'failed';
  return 'open';
}

function serviceOrderEvidencePinId(
  order: ServiceOrderRecord,
  event: MetaIDServiceOrderExperienceEvent,
): string | null {
  if (event === 'created') return text(order.orderPinId) || text(order.orderMessagePinId) || null;
  if (event === 'delivered') return text(order.deliveryMessagePinId) || null;
  if (event === 'refund_requested') return text(order.refundRequestPinId) || null;
  if (event === 'refunded') return text(order.refundFinalizePinId) || null;
  if (event === 'order_ended') return text(order.orderEndMessagePinId) || null;
  return null;
}

function serviceOrderEvidencePublisherGlobalMetaID(
  order: ServiceOrderRecord,
  event: MetaIDServiceOrderExperienceEvent,
  ownerGlobalMetaID: string,
  peerGlobalMetaID: string | null,
): string | null {
  const buyerGlobalMetaID = order.role === 'buyer' ? ownerGlobalMetaID : peerGlobalMetaID;
  const sellerGlobalMetaID = order.role === 'seller' ? ownerGlobalMetaID : peerGlobalMetaID;
  if (event === 'created' || event === 'refund_requested') return buyerGlobalMetaID;
  if (event === 'delivered' || event === 'refunded') return sellerGlobalMetaID;
  return null;
}

function serviceOrderEvidenceMessageId(
  order: ServiceOrderRecord,
  event: MetaIDServiceOrderExperienceEvent,
): string | null {
  return event === 'created' ? text(order.orderMessageTxid) || null : null;
}

/**
 * Record a service-order lifecycle observation as an owner-scoped episode.
 * Payment amounts and protocol identifiers are retained as metadata, while
 * no order prompt or private message text is copied into the cognition ledger.
 */
export function recordMetaIDServiceOrderExperience(
  input: RecordMetaIDServiceOrderExperienceInput,
): RecordMetaIDServiceOrderExperienceResult | null {
  const ownerGlobalMetaID = normalizeGlobalMetaID(input.ownerGlobalMetaID);
  const peerRaw = text(input.order.counterpartyGlobalMetaid);
  const peerGlobalMetaID = normalizeGlobalMetaID(peerRaw);
  const orderId = text(input.order.id);
  if (!ownerGlobalMetaID || !orderId || !peerRaw || ownerGlobalMetaID === peerGlobalMetaID) return null;
  const occurredAt = asTimestamp(input.occurredAt) ?? asTimestamp(input.order.updatedAt) ?? Date.now();
  const desiredEpisodeStatus = serviceOrderEpisodeStatus(input.order);
  const episodeResult = input.store.createEpisode({
    ownerGlobalMetaID,
    episodeType: 'service_order',
    sourceChannel: 'service_order',
    sourceKey: `order:${orderId}`,
    sessionId: text(input.order.coworkSessionId) || null,
    externalConversationId: text(input.order.coworkSessionId) || `service-order:${orderId}`,
    orderId,
    status: desiredEpisodeStatus,
    startedAt: asTimestamp(input.order.createdAt) ?? occurredAt,
    metadata: {
      interaction: 'service_order',
      event: input.event,
      role: input.order.role,
      status: input.order.status,
      servicePinId: text(input.order.servicePinId) || null,
      orderPinId: text(input.order.orderPinId) || null,
      paymentTxid: text(input.order.paymentTxid) || null,
      paymentChain: text(input.order.paymentChain) || null,
      paymentCurrency: text(input.order.paymentCurrency) || null,
      ...(input.sourceMetadata ?? {}),
    },
  });
  const episode = episodeResult.episode.status === desiredEpisodeStatus
    ? episodeResult.episode
    : input.store.updateEpisodeStatus({
        episodeId: episodeResult.episode.id,
        status: desiredEpisodeStatus,
        endedAt: desiredEpisodeStatus === 'open' ? null : occurredAt,
      });

  input.store.addParticipant({
    episodeId: episode.id,
    globalMetaID: ownerGlobalMetaID,
    role: input.order.role === 'buyer' ? 'buyer' : 'seller',
    source: 'service_order_local_identity',
  });
  if (peerGlobalMetaID) {
    input.store.addParticipant({
      episodeId: episode.id,
      globalMetaID: peerGlobalMetaID,
      role: input.order.role === 'buyer' ? 'seller' : 'buyer',
      source: 'service_order_counterparty_identity',
    });
  } else {
    input.store.addParticipant({
      episodeId: episode.id,
      unresolvedActorKey: `service-order-counterparty:${peerRaw}`,
      role: input.order.role === 'buyer' ? 'seller' : 'buyer',
      source: 'service_order_counterparty_unresolved',
    });
  }

  const eventSourceKey = `order:${orderId}:${input.event}`;
  const evidence = input.store.addEvidence({
    episodeId: episode.id,
    evidenceType: 'service_order_event',
    sourceKey: eventSourceKey,
    pinId: serviceOrderEvidencePinId(input.order, input.event),
    publisherGlobalMetaID: serviceOrderEvidencePublisherGlobalMetaID(
      input.order,
      input.event,
      ownerGlobalMetaID,
      peerGlobalMetaID,
    ),
    messageId: serviceOrderEvidenceMessageId(input.order, input.event),
    contentHash: hashContent(JSON.stringify({
      orderId,
      event: input.event,
      status: input.order.status,
      updatedAt: input.order.updatedAt,
    })),
    occurredAt,
    metadata: {
      event: input.event,
      role: input.order.role,
      status: input.order.status,
      failureReason: text(input.order.failureReason) || null,
      orderEndReason: text(input.order.orderEndReason) || null,
      ...(input.sourceMetadata ?? {}),
    },
  });
  return { episode, evidence };
}

/** Record one public group-task message for one local Bot's own ledger. */
export function recordMetaIDGroupTaskExperience(
  input: RecordMetaIDGroupTaskExperienceInput,
): { episode: MetaIDExperienceEpisode; evidence: MetaIDExperienceEvidence } | null {
  const ownerGlobalMetaID = normalizeGlobalMetaID(input.ownerGlobalMetaID);
  const taskId = identifier(input.taskId);
  const content = text(input.message.content);
  if (!ownerGlobalMetaID || !taskId || !content) return null;
  const occurredAt = asTimestamp(input.message.occurredAt) ?? Date.now();
  const episodeResult = input.store.createEpisode({
    ownerGlobalMetaID,
    episodeType: 'task_participation',
    sourceChannel: 'group_task',
    sourceKey: `task:${taskId}`,
    sessionId: text(input.sessionId) || null,
    externalConversationId: text(input.groupId) || `group-task:${taskId}`,
    taskId,
    status: 'open',
    startedAt: occurredAt,
    metadata: {
      interaction: 'group_task',
      taskId,
      groupId: text(input.groupId) || null,
    },
  });

  const participantInputs = input.participants ?? [];
  const seenParticipantKeys = new Set<string>();
  const addParticipant = (participant: MetaIDGroupTaskParticipantInput, fallbackRole: string): void => {
    const globalMetaID = normalizeGlobalMetaID(participant.globalMetaID);
    const unresolvedActorKey = text(participant.unresolvedActorKey);
    const role = text(participant.role) || fallbackRole;
    const participantKey = globalMetaID ? `global:${globalMetaID}` : `unresolved:${unresolvedActorKey}`;
    if ((!globalMetaID && !unresolvedActorKey) || seenParticipantKeys.has(`${participantKey}:${role}`)) return;
    seenParticipantKeys.add(`${participantKey}:${role}`);
    input.store.addParticipant({
      episodeId: episodeResult.episode.id,
      ...(globalMetaID ? { globalMetaID } : { unresolvedActorKey }),
      role,
      source: globalMetaID ? 'group_task_member_identity' : 'group_task_member_unresolved',
    });
  };

  addParticipant({ globalMetaID: ownerGlobalMetaID, role: 'observer' }, 'observer');
  for (const participant of participantInputs) addParticipant(participant, 'member');
  const senderGlobalMetaID = normalizeGlobalMetaID(input.message.senderGlobalMetaID);
  const senderMetaID = text(input.message.senderMetaID);
  const senderIsRostered = Boolean(
    senderGlobalMetaID
    && participantInputs.some((participant) => normalizeGlobalMetaID(participant.globalMetaID) === senderGlobalMetaID),
  );
  if (!senderIsRostered) {
    addParticipant(
      senderGlobalMetaID
        ? { globalMetaID: senderGlobalMetaID, role: 'sender' }
        : { unresolvedActorKey: `group-task-sender:${senderMetaID || input.message.id}`, role: 'sender' },
      'sender',
    );
  }

  const messageId = identifier(input.message.id);
  const messageKey = text(input.message.pinId) || messageId;
  if (!messageKey) return null;
  const evidence = input.store.addEvidence({
    episodeId: episodeResult.episode.id,
    evidenceType: 'group_task_message',
    sourceKey: `message:${messageKey}`,
    pinId: text(input.message.pinId) || null,
    publisherGlobalMetaID: senderGlobalMetaID || null,
    messageId: messageId || null,
    contentHash: hashContent(content),
    occurredAt,
    metadata: {
      taskId,
      groupId: text(input.groupId) || null,
      senderGlobalMetaID: senderGlobalMetaID || null,
      senderMetaID: senderMetaID || null,
      txId: text(input.message.txId) || null,
      replyPin: text(input.message.replyPin) || null,
    },
  });
  return { episode: episodeResult.episode, evidence };
}
