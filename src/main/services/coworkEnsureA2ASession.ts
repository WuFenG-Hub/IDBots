import type {
  CoworkConversationMapping,
  CoworkMessageMetadata,
  CoworkSession,
  CoworkStore,
} from '../coworkStore';
import type { Metabot } from '../types/metabot';
import { buildCanonicalPrivateConversationExternalConversationId } from './simplemsgPeerConversation';
import { resolveSessionWorkingDirectory } from '../libs/botWorkspace';

const RAW_GLOBAL_META_ID_VERSION_CHARS = new Set(['q', 'p', 'z', 'r', 'y', 't']);
/** Episode boundaries cap UI/storage growth without treating a five-minute topic gap as a new conversation. */
export const A2A_SESSION_EPISODE_IDLE_MS = 24 * 60 * 60 * 1000;
export const A2A_SESSION_EPISODE_MESSAGE_LIMIT = 500;

export type A2ASessionEpisodeRotationReason =
  | 'conversation_restarted'
  | 'archived_session'
  | 'message_limit'
  | 'idle_timeout';

export interface CoworkA2ASessionInput {
  actorId?: unknown;
  localMetabotId?: unknown;
  peerGlobalMetaId?: unknown;
  peerName?: unknown;
  peerAvatar?: unknown;
}

export interface NormalizedCoworkA2ASessionInput {
  localMetabotId: number;
  peerGlobalMetaId: string;
  peerName: string | null;
  peerAvatar: string | null;
}

export interface EnsureCoworkA2ASessionParams {
  coworkStore: CoworkStore;
  getMetabotById: (metabotId: number) => Pick<Metabot, 'id' | 'name' | 'globalmetaid'> | null;
  input: CoworkA2ASessionInput;
}

export interface EnsureCoworkA2ASessionResult {
  created: boolean;
  rotated?: boolean;
  rotationReason?: A2ASessionEpisodeRotationReason;
  externalConversationId: string;
  session: CoworkSession;
}

function parseMappingMetadata(value: string | null | undefined): CoworkMessageMetadata {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as CoworkMessageMetadata
      : {};
  } catch {
    return {};
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveA2ASessionEpisodeRotationReason(input: {
  mapping: Pick<CoworkConversationMapping, 'lastActiveAt' | 'metadataJson'>;
  messageCount: number;
  hasBlockingServiceOrders: boolean;
  isArchived: boolean;
  restartEndedConversation?: boolean;
  now?: number;
}): A2ASessionEpisodeRotationReason | null {
  if (input.hasBlockingServiceOrders) return null;

  const metadata = parseMappingMetadata(input.mapping.metadataJson);
  const persistedRestartRequest = typeof metadata.episodeRestartRequestedAt === 'number'
    && metadata.episodeRestartRequestedAt > 0;
  if ((input.restartEndedConversation === true && metadata.byeSent === true) || persistedRestartRequest) {
    return 'conversation_restarted';
  }
  if (input.isArchived) return 'archived_session';
  if (metadata.byeSent === true) return null;
  if (Math.max(0, Math.floor(input.messageCount)) >= A2A_SESSION_EPISODE_MESSAGE_LIMIT) {
    return 'message_limit';
  }

  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const lastActiveAt = Number(input.mapping.lastActiveAt);
  if (Number.isFinite(lastActiveAt) && lastActiveAt > 0 && now - lastActiveAt >= A2A_SESSION_EPISODE_IDLE_MS) {
    return 'idle_timeout';
  }
  return null;
}

export function rotateCoworkA2ASessionEpisode(input: {
  coworkStore: CoworkStore;
  mapping: CoworkConversationMapping;
  session: CoworkSession;
  externalConversationId: string;
  reason: A2ASessionEpisodeRotationReason;
  peerGlobalMetaId: string;
  peerName?: string | null;
  peerAvatar?: string | null;
  now?: number;
}): CoworkSession {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const mappingMetadata = parseMappingMetadata(input.mapping.metadataJson);
  const previousEpisodeIndex = positiveInteger(mappingMetadata.episodeIndex, 1);
  const episodeIndex = previousEpisodeIndex + 1;
  const peerName = text(input.peerName) || input.session.peerName || null;
  const peerAvatar = text(input.peerAvatar) || input.session.peerAvatar || null;
  const mappedMetabotId = Number(input.mapping.metabotId);
  const metabotId = typeof input.session.metabotId === 'number'
    ? input.session.metabotId
    : Number.isInteger(mappedMetabotId) && mappedMetabotId > 0
      ? mappedMetabotId
      : null;
  const session = input.coworkStore.createSession(
    input.session.title,
    input.session.cwd,
    input.session.systemPrompt,
    input.session.executionMode,
    input.session.activeSkillIds,
    metabotId,
    'a2a',
    input.peerGlobalMetaId,
    peerName,
    peerAvatar,
  );
  if (input.session.pinned) {
    input.coworkStore.setSessionPinned(session.id, true);
  }

  const sharedEpisodeMetadata: CoworkMessageMetadata = {
    a2aConversationId: input.externalConversationId,
    episodeIndex,
    episodeStartedAt: now,
    previousEpisodeSessionId: input.session.id,
    episodeReason: input.reason,
  };
  input.coworkStore.upsertConversationMapping({
    channel: 'metaweb_private',
    externalConversationId: input.externalConversationId,
    metabotId,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify({
      ...mappingMetadata,
      ...sharedEpisodeMetadata,
      peerGlobalMetaId: input.peerGlobalMetaId,
      peerName,
      peerAvatar,
      byeSent: false,
      endedByHuman: false,
      endedByAutoPolicy: false,
      endedAt: null,
      episodeRestartRequestedAt: null,
      restartedAt: now,
    }),
  });
  input.coworkStore.updateConversationMappingMetadata('cowork_ui', input.session.id, metabotId, {
    a2aConversationId: input.externalConversationId,
    episodeIndex: previousEpisodeIndex,
    episodeStartedAt: positiveInteger(mappingMetadata.episodeStartedAt, input.session.createdAt),
    nextEpisodeSessionId: session.id,
    episodeClosedAt: now,
    episodeCloseReason: input.reason,
    peerGlobalMetaId: input.peerGlobalMetaId,
  });
  input.coworkStore.updateConversationMappingMetadata('cowork_ui', session.id, metabotId, {
    ...sharedEpisodeMetadata,
    peerGlobalMetaId: input.peerGlobalMetaId,
  });
  input.coworkStore.archiveSession(input.session.id);

  return input.coworkStore.getSessionView(session.id) ?? session;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeGlobalMetaId(value: unknown): string {
  const normalized = text(value).toLowerCase();
  if (!normalized || normalized.startsWith('metaid:')) return '';
  if (!normalized.startsWith('id')) return '';
  if (!RAW_GLOBAL_META_ID_VERSION_CHARS.has(normalized[2] ?? '')) return '';
  if (normalized[3] !== '1') return '';
  return normalized;
}

function parseLocalMetabotActorId(actorId: unknown): number | null {
  const match = /^idbots-metabot-(\d+)$/.exec(text(actorId));
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizePositiveInteger(value: unknown): number | null {
  const textValue = typeof value === 'number'
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : '';
  if (!/^[1-9]\d*$/.test(textValue)) return null;
  const parsed = Number.parseInt(textValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeCoworkA2ASessionInput(
  input: CoworkA2ASessionInput,
): NormalizedCoworkA2ASessionInput {
  const localMetabotId = parseLocalMetabotActorId(input.actorId)
    ?? normalizePositiveInteger(input.localMetabotId);
  if (!localMetabotId) {
    throw new Error('A valid local Bot actor is required');
  }

  const peerGlobalMetaId = normalizeGlobalMetaId(input.peerGlobalMetaId);
  if (!peerGlobalMetaId) {
    throw new Error('A valid peer GlobalMetaID is required');
  }

  return {
    localMetabotId,
    peerGlobalMetaId,
    peerName: text(input.peerName) || null,
    peerAvatar: text(input.peerAvatar) || null,
  };
}

export function ensureCoworkA2ASession(
  params: EnsureCoworkA2ASessionParams,
): EnsureCoworkA2ASessionResult {
  const normalized = normalizeCoworkA2ASessionInput(params.input);
  const localMetabot = params.getMetabotById(normalized.localMetabotId);
  if (!localMetabot) {
    throw new Error('Local Bot not found');
  }

  const localGlobalMetaId = normalizeGlobalMetaId(localMetabot.globalmetaid);
  if (!localGlobalMetaId) {
    throw new Error('Local Bot GlobalMetaID is missing');
  }
  if (localGlobalMetaId === normalized.peerGlobalMetaId) {
    throw new Error('A Bot cannot open an A2A session with itself');
  }

  const externalConversationId = buildCanonicalPrivateConversationExternalConversationId(
    normalized.peerGlobalMetaId,
  );
  const existing = params.coworkStore.getConversationMapping(
    'metaweb_private',
    externalConversationId,
    normalized.localMetabotId,
  );
  if (existing) {
    const session = params.coworkStore.getSessionWithoutMessages(existing.coworkSessionId);
    if (session) {
      const repaired = params.coworkStore.ensureCanonicalPeerSessionShape({
        sessionId: existing.coworkSessionId,
        metabotId: normalized.localMetabotId,
        peerGlobalMetaId: normalized.peerGlobalMetaId,
        peerName: normalized.peerName,
        peerAvatar: normalized.peerAvatar,
      });
      if (repaired) {
        const repairedSession = params.coworkStore.getSessionWithoutMessages(existing.coworkSessionId) ?? session;
        const isArchived = params.coworkStore.isSessionArchived(repairedSession.id);
        const hasBlockingServiceOrders = params.coworkStore.hasBlockingServiceOrdersForSession(repairedSession.id);
        const rotationReason = resolveA2ASessionEpisodeRotationReason({
          mapping: existing,
          messageCount: params.coworkStore.getSessionMessageCount(repairedSession.id),
          hasBlockingServiceOrders,
          isArchived,
          restartEndedConversation: true,
        });
        if (rotationReason) {
          return {
            created: true,
            rotated: true,
            rotationReason,
            externalConversationId,
            session: rotateCoworkA2ASessionEpisode({
              coworkStore: params.coworkStore,
              mapping: existing,
              session: repairedSession,
              externalConversationId,
              reason: rotationReason,
              peerGlobalMetaId: normalized.peerGlobalMetaId,
              peerName: normalized.peerName,
              peerAvatar: normalized.peerAvatar,
            }),
          };
        }
        if (isArchived && hasBlockingServiceOrders) {
          params.coworkStore.unarchiveSession(repairedSession.id);
        }
        params.coworkStore.touchConversationMapping(
          'metaweb_private',
          externalConversationId,
          normalized.localMetabotId,
        );
        return {
          created: false,
          externalConversationId,
          session: params.coworkStore.getSessionView(existing.coworkSessionId) ?? repairedSession,
        };
      }
    }
    params.coworkStore.deleteConversationMapping(
      'metaweb_private',
      externalConversationId,
      normalized.localMetabotId,
    );
  }

  const config = params.coworkStore.getConfig();
  const workspaceRoot = resolveSessionWorkingDirectory(
    text(config.workingDirectory) || process.cwd(),
    normalized.localMetabotId,
  );
  const title = normalized.peerName || `Private-${normalized.peerGlobalMetaId.slice(0, 12)}`;
  const session = params.coworkStore.createSession(
    title,
    workspaceRoot,
    '',
    config.executionMode || 'local',
    [],
    normalized.localMetabotId,
    'a2a',
    normalized.peerGlobalMetaId,
    normalized.peerName,
    normalized.peerAvatar,
  );

  params.coworkStore.upsertConversationMapping({
    channel: 'metaweb_private',
    externalConversationId,
    metabotId: normalized.localMetabotId,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify({
      peerGlobalMetaId: normalized.peerGlobalMetaId,
      peerName: normalized.peerName,
      peerAvatar: normalized.peerAvatar,
      source: 'bot_browser',
      a2aConversationId: externalConversationId,
      episodeIndex: 1,
      episodeStartedAt: session.createdAt,
    }),
  });
  params.coworkStore.updateConversationMappingMetadata('cowork_ui', session.id, normalized.localMetabotId, {
    a2aConversationId: externalConversationId,
    episodeIndex: 1,
    episodeStartedAt: session.createdAt,
    peerGlobalMetaId: normalized.peerGlobalMetaId,
  });

  return {
    created: true,
    externalConversationId,
    session: params.coworkStore.getSessionView(session.id) ?? session,
  };
}
