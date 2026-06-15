import type {
  CoworkMessage,
  CoworkMessageMetadata,
  CoworkSession,
  CoworkSessionMetadata as CoworkStoreSessionMetadata,
  CoworkSessionType,
} from '../coworkStore';

export const CROSS_SESSION_INSERT_MAX_CHARS = 12000;

export type CoworkCrossSessionErrorCode =
  | 'INVALID_SESSION_ID'
  | 'SESSION_NOT_FOUND'
  | 'WRITE_NOT_ALLOWED_FOR_A2A'
  | 'SOURCE_TARGET_SAME_SESSION'
  | 'EMPTY_MESSAGE'
  | 'MESSAGE_TOO_LONG';

export interface CoworkCrossSessionError {
  ok: false;
  code: CoworkCrossSessionErrorCode;
  message: string;
}

export interface CoworkCrossSessionNormalizeSuccess {
  ok: true;
  sessionId: string;
}

export type CoworkCrossSessionNormalizeResult =
  | CoworkCrossSessionNormalizeSuccess
  | CoworkCrossSessionError;

export interface CoworkCrossSessionMessage {
  id: string;
  type: CoworkMessage['type'];
  content: string;
  timestamp: number;
  metadata: CoworkMessageMetadata | null;
}

export interface CoworkCrossSessionMetadata {
  id: string;
  title: string;
  status: CoworkSession['status'];
  pinned: boolean;
  sessionType: CoworkSessionType;
  hiddenFromSessionList: boolean;
  createdAt: number;
  updatedAt: number;
  metabotId: number | null;
  peerGlobalMetaId: string | null;
  peerName: string | null;
}

export interface CoworkCrossSessionReadAllSuccess {
  ok: true;
  session: CoworkCrossSessionMetadata;
  messages: CoworkCrossSessionMessage[];
}

export interface CoworkCrossSessionReadLatestSuccess {
  ok: true;
  session: CoworkCrossSessionMetadata;
  message: CoworkCrossSessionMessage | null;
}

export interface CoworkCrossSessionInsertSuccess {
  ok: true;
  sourceSessionId: string;
  targetSessionId: string;
  message: CoworkCrossSessionMessage;
}

export type CoworkCrossSessionReadAllResult =
  | CoworkCrossSessionReadAllSuccess
  | CoworkCrossSessionError;

export type CoworkCrossSessionReadLatestResult =
  | CoworkCrossSessionReadLatestSuccess
  | CoworkCrossSessionError;

export type CoworkCrossSessionInsertResult =
  | CoworkCrossSessionInsertSuccess
  | CoworkCrossSessionError;

export interface CoworkCrossSessionStore {
  getSession(sessionId: string): CoworkSession | null;
  getSessionMetadata(sessionId: string): CoworkStoreSessionMetadata | null;
  getSessionLatestMessage(sessionId: string): CoworkMessage | null;
  addMessage(sessionId: string, message: Omit<CoworkMessage, 'id' | 'timestamp'>): CoworkMessage;
}

const IDBOTS_SESSION_SCHEME = /^idbots:\/\//i;
const VALID_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function error(code: CoworkCrossSessionErrorCode, message: string): CoworkCrossSessionError {
  return { ok: false, code, message };
}

export function normalizeIdbotsSessionId(input: unknown): CoworkCrossSessionNormalizeResult {
  if (typeof input !== 'string') {
    return error('INVALID_SESSION_ID', 'Invalid IDBots session id.');
  }

  const trimmed = input.trim();
  const sessionId = trimmed.replace(IDBOTS_SESSION_SCHEME, '');
  if (!sessionId) {
    return error('INVALID_SESSION_ID', 'Invalid IDBots session id.');
  }
  if (sessionId.includes('/') || /\s/.test(sessionId) || !VALID_SESSION_ID_PATTERN.test(sessionId)) {
    return error('INVALID_SESSION_ID', 'Invalid IDBots session id.');
  }

  return { ok: true, sessionId };
}

export function formatIdbotsSessionLink(sessionId: string): string {
  const normalized = normalizeIdbotsSessionId(sessionId);
  if (normalized.ok) {
    return `IDBots://${normalized.sessionId}`;
  }
  return `IDBots://${String(sessionId ?? '').trim()}`;
}

function toSessionMetadata(session: CoworkSession | CoworkStoreSessionMetadata): CoworkCrossSessionMetadata {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    pinned: Boolean(session.pinned),
    sessionType: session.sessionType || 'standard',
    hiddenFromSessionList: Boolean(session.hiddenFromSessionList),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    metabotId: session.metabotId ?? null,
    peerGlobalMetaId: session.peerGlobalMetaId ?? null,
    peerName: session.peerName ?? null,
  };
}

function toMessage(message: CoworkMessage): CoworkCrossSessionMessage {
  return {
    id: message.id,
    type: message.type,
    content: message.content,
    timestamp: message.timestamp,
    metadata: message.metadata ?? null,
  };
}

export class CoworkCrossSessionService {
  constructor(private readonly store: CoworkCrossSessionStore) {}

  readAll(input: { sessionId: string }): CoworkCrossSessionReadAllResult {
    const resolved = this.getExistingSession(input.sessionId);
    if (resolved.ok === false) {
      return resolved;
    }

    return {
      ok: true,
      session: toSessionMetadata(resolved.session),
      messages: resolved.session.messages.map(toMessage),
    };
  }

  readLatest(input: { sessionId: string }): CoworkCrossSessionReadLatestResult {
    const resolved = this.getExistingSessionMetadata(input.sessionId);
    if (resolved.ok === false) {
      return resolved;
    }

    const latestMessage = this.store.getSessionLatestMessage(resolved.sessionId);
    return {
      ok: true,
      session: toSessionMetadata(resolved.session),
      message: latestMessage ? toMessage(latestMessage) : null,
    };
  }

  insertUserMessage(input: {
    sourceSessionId: string;
    targetSessionId: string;
    message: string;
  }): CoworkCrossSessionInsertResult {
    const sourceId = normalizeIdbotsSessionId(input.sourceSessionId);
    if (sourceId.ok === false) {
      return sourceId;
    }
    const targetId = normalizeIdbotsSessionId(input.targetSessionId);
    if (targetId.ok === false) {
      return targetId;
    }

    if (sourceId.sessionId === targetId.sessionId) {
      return error('SOURCE_TARGET_SAME_SESSION', 'Source and target session ids must be different.');
    }

    const sourceSession = this.store.getSession(sourceId.sessionId);
    if (!sourceSession) {
      return error('SESSION_NOT_FOUND', `Source session not found: ${sourceId.sessionId}`);
    }

    const targetSession = this.store.getSession(targetId.sessionId);
    if (!targetSession) {
      return error('SESSION_NOT_FOUND', `Target session not found: ${targetId.sessionId}`);
    }
    if (targetSession.sessionType === 'a2a') {
      return error('WRITE_NOT_ALLOWED_FOR_A2A', 'Cross-session user message insert is not allowed for A2A target sessions.');
    }

    const trimmedMessage = input.message.trim();
    if (!trimmedMessage) {
      return error('EMPTY_MESSAGE', 'Message must not be empty.');
    }
    if (trimmedMessage.length > CROSS_SESSION_INSERT_MAX_CHARS) {
      return error('MESSAGE_TOO_LONG', `Message must be ${CROSS_SESSION_INSERT_MAX_CHARS} characters or fewer.`);
    }

    const message = this.store.addMessage(targetId.sessionId, {
      type: 'user',
      content: `来自${sourceId.sessionId} 的信息：${trimmedMessage}`,
      metadata: {
        sourceChannel: 'idbots_cross_session',
        sourceSessionId: sourceId.sessionId,
      },
    });

    return {
      ok: true,
      sourceSessionId: sourceId.sessionId,
      targetSessionId: targetId.sessionId,
      message: toMessage(message),
    };
  }

  private getExistingSession(rawSessionId: string): (
    | { ok: true; sessionId: string; session: CoworkSession }
    | CoworkCrossSessionError
  ) {
    const parsed = normalizeIdbotsSessionId(rawSessionId);
    if (parsed.ok === false) {
      return parsed;
    }

    const session = this.store.getSession(parsed.sessionId);
    if (!session) {
      return error('SESSION_NOT_FOUND', `Session not found: ${parsed.sessionId}`);
    }

    return {
      ok: true,
      sessionId: parsed.sessionId,
      session,
    };
  }

  private getExistingSessionMetadata(rawSessionId: string): (
    | { ok: true; sessionId: string; session: CoworkStoreSessionMetadata }
    | CoworkCrossSessionError
  ) {
    const parsed = normalizeIdbotsSessionId(rawSessionId);
    if (parsed.ok === false) {
      return parsed;
    }

    const session = this.store.getSessionMetadata(parsed.sessionId);
    if (!session) {
      return error('SESSION_NOT_FOUND', `Session not found: ${parsed.sessionId}`);
    }

    return {
      ok: true,
      sessionId: parsed.sessionId,
      session,
    };
  }
}
