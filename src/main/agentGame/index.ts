/**
 * Agent-Game-v2 host wiring (docs/14 §1, §2, §5).
 *
 * Builds the persistent runtime + consent manager from the shared sql.js store
 * and the existing group-chat / LLM / chain-write infrastructure, registers the
 * `browser.app.session.*` IPC surface, and exposes the message-intake hook that
 * the group-chat ingest path calls after inserting a message.
 *
 * Called once from main.ts after the sqlite stores + group-chat daemons start.
 */

import { randomUUID } from 'crypto';
import { AgentGameSessionStore } from './sessionStore';
import { AgentGameRuntime, type RuntimeDeps, type SessionMessage, RuntimeError } from './runtime';
import { ConsentManager } from './consent';
import {
  toSessionView,
  type GameManifest,
  type GameSession,
  type SessionConsent,
  type SessionStartParams,
  type SessionView,
} from './abi';
import type { SqliteDatabase as Database } from '../sqliteTypes';
import type { ChatCompletionResult, ChatMessage } from '../services/cognitiveChatCompletion';

/** Deps supplied by main.ts (all resolve to existing infra). */
export interface AgentGameHostDeps {
  db: Database;
  saveDb: () => void;
  /** chatCompletionWithTools (main process LLM entry). */
  llmComplete: (messages: ChatMessage[], opts: { timeoutMs: number; llmId?: string | null }) => Promise<ChatCompletionResult>;
  /** sendGroupChatMessageAsIdentity (host owner identity signs /protocols/simplegroupchat).
   *  `opts.asAgentId`: sign as a local bot identity instead — seat.claimed is
   *  attributed by the chain message's senderMetaId (docs/07 §3). */
  chainWrite: (groupId: string, plaintext: string, opts?: { asAgentId?: string }) => Promise<{ pinId: string }>;
  /** Fetch + JSON.parse a GameManifest from its URI. */
  manifestFetch: (manifestUri: string) => Promise<GameManifest>;
  /** Resolve a local adapter.js path from manifestUri (e.g. from the MetaApp cache). */
  adapterPathFor: (manifestUri: string, manifest: GameManifest) => Promise<string>;
  /** Resolve the actor globalMetaId at request time. */
  resolveActor: () => string;
  /** Resolve a display name for the actor (consent card); empty when unknown. */
  actorNameFor?: (globalMetaId: string) => string;
  log?: (msg: string) => void;
}

export interface AgentGameHost {
  runtime: AgentGameRuntime;
  consent: ConsentManager;
  store: AgentGameSessionStore;
  /** Group-chat ingest hook — call after a message is inserted. No-op w/o a session. */
  onGroupMessage: (groupId: string) => void;
  /** Active game groupIds (fed into the group-chat backfill active set). */
  activeGroupIds: () => string[];
  /** Dispatch a browser.app.session.* method (the IPC entry). */
  handleSessionMethod: (
    method: string,
    payload: unknown,
    actorId: string,
    ctx?: SessionMethodContext,
  ) => Promise<unknown>;
  /** Consent response from the renderer. */
  respondConsent: (requestId: string, approved: boolean, reason?: string) => void;
  /** Recover unfinished sessions on host start. */
  recover: () => Promise<void>;
  dispose: () => Promise<void>;
}

/** Per-request transport context forwarded by the Bot Browser host adapter. */
export interface SessionMethodContext {
  /** The MetaApp resource URI the page call is bound to (browser trusted action). */
  resourceUri?: string;
}

/* ------------------------------------------------------------------ */
/* Two-phase start (docs/09 §4.1, docs/14 §1)                          */
/*                                                                     */
/* Phase 1 validates params + manifest and issues an opaque token      */
/* (`manual_action_required` + { confirmation, confirmRequest }); ABC  */
/* renders the authorization card. Phase 2 re-submits the host-issued  */
/* confirmRequest; the host verifies token/resourceUri/actor, then     */
/* creates (or idempotently reuses) the Session. This replaces the     */
/* own-consent-card direct path for browser-initiated starts.          */
/* ------------------------------------------------------------------ */

/** A start confirmation issued in Phase 1, awaiting the Phase 2 echo. */
interface PendingSessionStart {
  params: SessionStartParams;
  manifest: GameManifest;
  /** Page resource URI bound into the confirmRequest (must match on echo). */
  resourceUri: string;
  /** Actor globalMetaId that requested the confirmation. */
  actorId: string;
  expiresAt: number;
}

/** How long a Phase 1 confirmation stays redeemable. */
const CONFIRM_TTL_MS = 10 * 60 * 1000;
/** Upper bound on live confirmations (per-identity spam guard). */
const MAX_PENDING_STARTS = 64;

/** Grant binding URI — must stay identical to the ConsentManager wiring below. */
const grantResourceUriFor = (params: SessionStartParams): string => `metaapp://${params.appId}`;

function requireNonEmpty(params: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    if (typeof params[key] !== 'string' || !(params[key] as string).trim()) {
      throw new RuntimeError('invalid_params', `start requires a non-empty ${key}`);
    }
  }
}

/** Read group-chat messages for a group strictly after the given msg_index. */
function readMessagesSince(db: Database, groupId: string, afterMsgIndex: number): SessionMessage[] {
  const result = db.exec(
    `SELECT pin_id, content, sender_global_metaid, msg_index, chain_timestamp
     FROM group_chat_messages
     WHERE group_id = ? AND (msg_index IS NULL OR msg_index > ?)
     ORDER BY msg_index ASC NULLS LAST, id ASC`,
    [groupId, afterMsgIndex],
  );
  if (!result[0]?.values) return [];
  return result[0].values.map((row) => ({
    pinId: String(row[0] ?? ''),
    content: String(row[1] ?? ''),
    senderGlobalMetaId: row[2] ? String(row[2]) : null,
    msgIndex: row[3] === null || row[3] === undefined ? null : Number(row[3]),
    chainTimestamp: row[4] === null || row[4] === undefined ? null : Number(row[4]),
  }));
}

/** Build and wire the host runtime. */
export function createAgentGameHost(deps: AgentGameHostDeps): AgentGameHost {
  const store = new AgentGameSessionStore(deps.db, deps.saveDb);

  const runtimeDeps: RuntimeDeps = {
    store,
    messageStore: {
      readSince: (groupId, afterMsgIndex) => readMessagesSince(deps.db, groupId, afterMsgIndex),
    },
    llmComplete: deps.llmComplete,
    chainWrite: deps.chainWrite,
    manifestFetch: deps.manifestFetch,
    adapterPathFor: deps.adapterPathFor,
    agentNameFor: deps.actorNameFor,
    log: deps.log,
  };
  const runtime = new AgentGameRuntime(runtimeDeps);
  const consent = new ConsentManager({
    store,
    resourceUriFor: grantResourceUriFor,
    resolveActor: deps.resolveActor,
    log: deps.log,
  });

  // Phase 1 confirmations, keyed by the opaque token carried in
  // confirmRequest.payload. Single-use; expires after CONFIRM_TTL_MS.
  const pendingStarts = new Map<string, PendingSessionStart>();

  const pruneExpiredStarts = (now: number): void => {
    for (const [token, pending] of pendingStarts) {
      if (pending.expiresAt <= now) pendingStarts.delete(token);
    }
  };

  /** Phase 1: validate + fetch manifest + issue confirmation. */
  const beginSessionStart = async (
    payload: unknown,
    actorId: string,
    ctx: SessionMethodContext | undefined,
  ): Promise<unknown> => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new RuntimeError('invalid_params', 'start requires an object payload');
    }
    const raw = payload as Record<string, unknown>;
    requireNonEmpty(raw, [
      'appId',
      'sessionType',
      'groupId',
      'gameId',
      'manifestUri',
      'rulesHash',
      'seat',
      'agentId',
    ]);
    const ttlMs = raw.ttlMs;
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RuntimeError('invalid_params', 'start requires a positive numeric ttlMs');
    }
    const budgetRaw = raw.budget as { llmCalls?: unknown; writes?: unknown } | undefined;
    if (
      !budgetRaw ||
      typeof budgetRaw.llmCalls !== 'number' ||
      !(budgetRaw.llmCalls >= 0) ||
      typeof budgetRaw.writes !== 'number' ||
      !(budgetRaw.writes >= 0)
    ) {
      throw new RuntimeError('invalid_params', 'start requires a budget with llmCalls and writes');
    }
    const params: SessionStartParams = {
      appId: String(raw.appId),
      sessionType: String(raw.sessionType),
      groupId: String(raw.groupId),
      gameId: String(raw.gameId),
      manifestUri: String(raw.manifestUri),
      rulesHash: String(raw.rulesHash),
      seat: String(raw.seat),
      agentId: String(raw.agentId),
      ttlMs,
      budget: { llmCalls: budgetRaw.llmCalls, writes: budgetRaw.writes },
      ...(Array.isArray(raw.protocolPaths)
        ? { protocolPaths: (raw.protocolPaths as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0) }
        : {}),
    };
    // docs/09 §4.1 #2: the caller must be the current browser actor.
    if (!actorId || params.agentId !== actorId) {
      throw new RuntimeError('invalid_params', 'start agentId must match the current actor');
    }
    if (!ctx?.resourceUri) {
      throw new RuntimeError('invalid_params', 'start requires an active Browser resource');
    }
    const now = Date.now();
    pruneExpiredStarts(now);
    if (pendingStarts.size >= MAX_PENDING_STARTS) {
      throw new RuntimeError('rate_limited', 'too many pending app session confirmations');
    }

    let manifest: GameManifest;
    try {
      manifest = await deps.manifestFetch(params.manifestUri);
    } catch (err) {
      throw new RuntimeError(
        'adapter_invalid',
        `manifest unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (manifest.protocol !== 'agent-game/1') {
      throw new RuntimeError('adapter_invalid', `unsupported manifest protocol ${manifest.protocol}`);
    }
    if (manifest.gameId !== params.gameId) {
      throw new RuntimeError('adapter_invalid', `manifest gameId ${manifest.gameId} != ${params.gameId}`);
    }
    if (typeof raw.adapterHash === 'string' && raw.adapterHash && raw.adapterHash !== manifest.adapterHash) {
      throw new RuntimeError('adapter_invalid', 'adapterHash does not match the manifest');
    }
    // Light seat sanity check for numeric seats; named seats are validated by
    // the adapter smoke test + protocol replay in runtime.start.
    if (/^\d+$/.test(params.seat) && Number(params.seat) >= manifest.maxPlayers) {
      throw new RuntimeError('seat_unavailable', `seat ${params.seat} outside manifest maxPlayers ${manifest.maxPlayers}`);
    }

    const token = randomUUID();
    const pending: PendingSessionStart = {
      params,
      manifest,
      resourceUri: ctx.resourceUri,
      actorId,
      expiresAt: now + CONFIRM_TTL_MS,
    };
    pendingStarts.set(token, pending);
    store.audit('start-confirm-issued', null, actorId, {
      gameId: params.gameId,
      groupId: params.groupId,
      seat: params.seat,
    });
    deps.log?.(`[agent-game] start confirmation issued for ${params.gameId}/${params.seat} in ${params.groupId}`);
    const protocolPaths = params.protocolPaths ?? ['/protocols/simplegroupchat'];
    return {
      manualAction: true,
      confirmation: {
        actor: {
          uri: `metaid://${actorId}`,
          globalMetaId: actorId,
          name: deps.actorNameFor?.(actorId) || actorId,
        },
        resourceUri: ctx.resourceUri,
        appId: params.appId,
        sessionType: params.sessionType,
        groupId: params.groupId,
        gameId: params.gameId,
        manifestUri: params.manifestUri,
        rulesHash: params.rulesHash,
        adapterHash: manifest.adapterHash,
        seat: params.seat,
        protocolPaths,
        ttlMs: params.ttlMs,
        llmBudget: params.budget.llmCalls,
        writeBudget: params.budget.writes,
        expiresAt: pending.expiresAt,
      },
      confirmRequest: {
        kind: 'app-session-start',
        resourceUri: ctx.resourceUri,
        payload: { confirmToken: token },
      },
    };
  };

  /** Idempotent reuse per docs/09 §4.1: same (groupId, seat, agentId, rulesHash). */
  const findReusableSession = (params: SessionStartParams): GameSession | undefined => {
    return store
      .listSessions({ agentId: params.agentId, groupId: params.groupId })
      .find(
        (s) =>
          s.seat === params.seat &&
          s.rulesHash === params.rulesHash &&
          (s.status === 'running' || s.status === 'paused'),
      );
  };

  /** Phase 2: verify the echoed confirmRequest and start/reuse the session. */
  const completeSessionStart = async (
    payload: unknown,
    actorId: string,
    ctx: SessionMethodContext | undefined,
  ): Promise<unknown> => {
    const token =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as { confirmToken?: unknown }).confirmToken
        : undefined;
    const pending = typeof token === 'string' ? pendingStarts.get(token) : undefined;
    // docs/09 §4.1: tampered token/resource/actor is consent_denied, always.
    if (!pending) {
      throw new RuntimeError('consent_denied', 'unknown or expired start confirmation');
    }
    if (pending.resourceUri !== ctx?.resourceUri) {
      pendingStarts.delete(token as string);
      throw new RuntimeError('consent_denied', 'start confirmation does not match this resource');
    }
    if (pending.actorId !== actorId) {
      pendingStarts.delete(token as string);
      throw new RuntimeError('consent_denied', 'start confirmation was issued to a different actor');
    }
    pendingStarts.delete(token as string);
    const params = pending.params;
    const existing = findReusableSession(params);
    if (existing) {
      return toSessionView(existing);
    }
    const protocolPaths = params.protocolPaths ?? ['/protocols/simplegroupchat'];
    const consent: SessionConsent = {
      actorId: params.agentId,
      appId: params.appId,
      groupId: params.groupId,
      gameId: params.gameId,
      rulesHash: params.rulesHash,
      adapterHash: pending.manifest.adapterHash,
      seat: params.seat,
      resourceUri: grantResourceUriFor(params),
      protocolPaths,
      ttlMs: params.ttlMs,
      budget: {
        llmCalls: params.budget.llmCalls,
        llmCallsUsed: 0,
        writes: params.budget.writes,
        writesUsed: 0,
      },
      grantedAt: Date.now(),
    };
    store.audit('consent-granted', null, actorId, {
      via: 'confirm-request',
      gameId: params.gameId,
      groupId: params.groupId,
      seat: params.seat,
      ttlMs: params.ttlMs,
    });
    // `return await` (not a bare `return`): a bare return adopts the rejection
    // OUTSIDE this handler's try/catch and loses the docs/09 error envelope
    // at the IPC boundary.
    return await runtime.start(params, consent);
  };

  const isSessionStartConfirmation = (payload: unknown): boolean =>
    Boolean(
      payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        typeof (payload as { confirmToken?: unknown }).confirmToken === 'string',
    );

  const handleSessionMethod = async (
    method: string,
    payload: unknown,
    actorId: string,
    ctx?: SessionMethodContext,
  ): Promise<unknown> => {
    try {
      switch (method) {
        case 'start': {
          return isSessionStartConfirmation(payload)
            ? await completeSessionStart(payload, actorId, ctx)
            : await beginSessionStart(payload, actorId, ctx);
        }
        case 'list': {
          const p = (payload as { appId?: string; status?: SessionView['status']; groupId?: string }) ?? {};
          return { sessions: runtime.list(actorId, { appId: p.appId, status: p.status, groupId: p.groupId }) };
        }
        case 'status': {
          const p = payload as { sessionId: string };
          return await runtime.status(p.sessionId);
        }
        case 'pause': {
          const p = payload as { sessionId: string };
          return await runtime.pause(p.sessionId);
        }
        case 'resume': {
          const p = payload as { sessionId: string };
          return await runtime.resume(p.sessionId);
        }
        case 'stop': {
          const p = payload as { sessionId: string; releaseSeat?: boolean };
          return await runtime.stop(p.sessionId, p.releaseSeat);
        }
        default:
          throw new RuntimeError('unsupported_method', `browser.app.session.${method} not implemented`);
      }
    } catch (err) {
      if (err instanceof RuntimeError) {
        return { __error: true, code: err.code, message: err.message };
      }
      return { __error: true, code: 'internal_error', message: err instanceof Error ? err.message : String(err) };
    }
  };

  return {
    runtime,
    consent,
    store,
    onGroupMessage: (groupId) => runtime.onGroupMessage(groupId),
    activeGroupIds: () => store.listActiveGroupIds(),
    handleSessionMethod,
    respondConsent: (requestId, approved, reason) => consent.respond(requestId, approved, reason),
    recover: () => runtime.recover(),
    dispose: () => runtime.dispose(),
  };
}
