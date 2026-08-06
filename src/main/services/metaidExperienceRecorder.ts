import { createHash } from 'node:crypto';
import type {
  MetaIDExperienceStore,
  MetaIDExperienceEpisode,
  MetaIDExperienceEvidence,
} from '../metaidExperienceStore';
import { normalizeGlobalMetaID } from '../shared/globalMetaId';

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

const handshakeText = new Set(['ping', 'pong']);

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
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
