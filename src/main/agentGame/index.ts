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

import { AgentGameSessionStore } from './sessionStore';
import { AgentGameRuntime, type RuntimeDeps, type SessionMessage, RuntimeError } from './runtime';
import { ConsentManager } from './consent';
import {
  toSessionView,
  type GameManifest,
  type GameSession,
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
  /** sendGroupChatMessageAsIdentity (host owner identity signs /protocols/simplegroupchat). */
  chainWrite: (groupId: string, plaintext: string) => Promise<{ pinId: string }>;
  /** Fetch + JSON.parse a GameManifest from its URI. */
  manifestFetch: (manifestUri: string) => Promise<GameManifest>;
  /** Resolve a local adapter.js path from manifestUri (e.g. from the MetaApp cache). */
  adapterPathFor: (manifestUri: string, manifest: GameManifest) => string;
  /** Resolve the actor globalMetaId at request time. */
  resolveActor: () => string;
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
  handleSessionMethod: (method: string, payload: unknown, actorId: string) => Promise<unknown>;
  /** Consent response from the renderer. */
  respondConsent: (requestId: string, approved: boolean, reason?: string) => void;
  /** Recover unfinished sessions on host start. */
  recover: () => Promise<void>;
  dispose: () => Promise<void>;
}

/** Read group-chat messages for a group strictly after the given msg_index. */
function readMessagesSince(db: Database, groupId: string, afterMsgIndex: number): SessionMessage[] {
  const result = db.exec(
    `SELECT pin_id, content, sender_global_metaid, msg_index
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
    log: deps.log,
  };
  const runtime = new AgentGameRuntime(runtimeDeps);
  const consent = new ConsentManager({
    store,
    resourceUriFor: (params) => `metaapp://${params.appId}`,
    resolveActor: deps.resolveActor,
    log: deps.log,
  });

  const handleSessionMethod = async (
    method: string,
    payload: unknown,
    actorId: string,
  ): Promise<unknown> => {
    try {
      switch (method) {
        case 'start': {
          const params = payload as SessionStartParams;
          const manifest = await deps.manifestFetch(params.manifestUri);
          const decision = await consent.requestAuthorization(params, manifest);
          if (decision.approved) {
            return runtime.start(params, decision.consent);
          }
          throw new RuntimeError('consent_denied', (decision as { reason: string }).reason);
        }
        case 'list': {
          const p = (payload as { appId?: string; status?: SessionView['status']; groupId?: string }) ?? {};
          return { sessions: runtime.list(actorId, { appId: p.appId, status: p.status, groupId: p.groupId }) };
        }
        case 'status': {
          const p = payload as { sessionId: string };
          return runtime.status(p.sessionId);
        }
        case 'pause': {
          const p = payload as { sessionId: string };
          return runtime.pause(p.sessionId);
        }
        case 'resume': {
          const p = payload as { sessionId: string };
          return runtime.resume(p.sessionId);
        }
        case 'stop': {
          const p = payload as { sessionId: string; releaseSeat?: boolean };
          return runtime.stop(p.sessionId, p.releaseSeat);
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
