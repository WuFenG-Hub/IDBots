/**
 * Persistent App/Game Runtime (docs/14 §2, §5, §6, §7).
 *
 * Game-agnostic: each game is a sandboxed `adapter.js`. The Runtime owns
 * Session lifecycle, message intake (reusing the existing group-chat socket +
 * history backfill), the action loop, idempotent chain writes, lease/fencing,
 * and recovery on host restart. MetaApp close does not stop a Session.
 *
 * Injected deps keep the Runtime testable and decoupled from Electron:
 *  - messageStore: reads group_chat_messages rows since a cursor
 *  - llmComplete: chatCompletionWithTools (same stack as Cowork/bridge)
 *  - chainWrite: sendGroupChatMessageAsIdentity (host owner identity signs)
 *  - manifestFetch: loads + JSON-parses a GameManifest
 *  - adapterPathFor: resolves a local adapter.js path from manifestUri
 */

import { EventEmitter } from 'events';
import { createHash, randomUUID } from 'crypto';
import { loadAdapterSandbox, AdapterError, type AdapterSandbox } from './adapterSandbox';
import { AgentGameSessionStore, type WriteLogKey } from './sessionStore';
import { LeaseRegistry, LEASE_HEARTBEAT_INTERVAL_MS } from './leaseRegistry';
import { buildMovePrompt } from './llmStrategy';
import {
  isActionEvent,
  toSessionView,
  type ActionEvent,
  type GameEvent,
  type GameManifest,
  type GameSession,
  type SessionBudget,
  type SessionConsent,
  type SessionError,
  type SessionErrorCode,
  type SessionStartParams,
  type SessionStatus,
  type SessionView,
} from './abi';
import type { ChatCompletionResult } from '../services/cognitiveChatCompletion';

/* ------------------------------------------------------------------ */
/* Injected dependencies                                              */
/* ------------------------------------------------------------------ */

/** A decrypted group-chat message row relevant to a session. */
export interface SessionMessage {
  /** Group message index (cursor). */
  msgIndex: number | null;
  content: string;
  senderGlobalMetaId: string | null;
  pinId: string;
}

export interface RuntimeDeps {
  store: AgentGameSessionStore;
  /** Read group-chat messages for a group strictly after the given msg_index. */
  messageStore: {
    readSince(groupId: string, afterMsgIndex: number): SessionMessage[];
  };
  /** One-shot LLM call (chatCompletionWithTools). Throws on abort/timeout. */
  llmComplete: (messages: import('../services/cognitiveChatCompletion').ChatMessage[], opts: { timeoutMs: number }) => Promise<ChatCompletionResult>;
  /** Write an encrypted agent-game/1 event to the group (returns pinId). */
  chainWrite: (groupId: string, plaintext: string) => Promise<{ pinId: string }>;
  /** Fetch + parse a GameManifest from its URI. */
  manifestFetch: (manifestUri: string) => Promise<GameManifest>;
  /** Resolve a local filesystem path for the adapter module from manifestUri. */
  adapterPathFor: (manifestUri: string, manifest: GameManifest) => string;
  /** Clock injection (tests). */
  now?: () => number;
  /** Log sink. */
  log?: (msg: string) => void;
}

export interface RuntimeEvents {
  sessionUpdated: (session: GameSession) => void;
  consentRequired: (requestId: string, params: SessionStartParams, manifest: GameManifest) => void;
}

/* ------------------------------------------------------------------ */
/* Tunables                                                           */
/* ------------------------------------------------------------------ */

const LLM_CALL_TIMEOUT_MS = 120_000;
const LLM_MAX_PARSE_ATTEMPTS = 3;
/** Backoff schedule (ms) for failed writes / LLM calls — bounded, no quota burst. */
const WRITE_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];
const ACTION_LOOP_DEBOUNCE_MS = 500;

/* ------------------------------------------------------------------ */
/* Runtime                                                            */
/* ------------------------------------------------------------------ */

export class AgentGameRuntime extends EventEmitter {
  private leases = new LeaseRegistry();
  /** sessionId -> active sandbox. */
  private sandboxes = new Map<string, AdapterSandbox>();
  /** In-memory working state (canonical source = store; this is the hot copy). */
  private states = new Map<string, unknown>();
  /** Sessions currently inside the action loop (re-entry guard). */
  private busy = new Set<string>();
  /** Pending (in-flight) write per session for retry/dedup. */
  private pending = new Map<string, { event: ActionEvent; key: WriteLogKey }>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly now: () => number;

  constructor(private deps: RuntimeDeps) {
    super();
    this.now = deps.now ?? Date.now;
  }

  private log(msg: string): void {
    this.deps.log?.(`[agent-game] ${msg}`);
  }

  /* ----------------------- lifecycle ----------------------- */

  /** Start background housekeeping (lease heartbeat + loop tick). */
  startBackground(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.housekeeping(), LEASE_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    this.scheduleLoop(0);
  }

  /** Recover unfinished sessions after host restart (docs/14 §5). */
  async recover(): Promise<void> {
    const sessions = this.deps.store.listRecoverableSessions();
    this.log(`recovering ${sessions.length} unfinished session(s)`);
    for (const s of sessions) {
      // Re-verify grant: not revoked / expired / depleted.
      if (this.isExpiredOrDepleted(s)) {
        this.markStatus(
          s.sessionId,
          'paused',
          mkError(s.expiresAt <= this.now() ? 'rate_limited' : 'budget_exhausted', 'authorization expired or budget depleted on recovery', this.now),
        );
        continue;
      }
      try {
        await this.ensureSandbox(s);
        await this.catchUp(s.sessionId);
        // Re-acquire lease (fresh id) — conflict stays paused.
        const res = this.leases.acquire(s.groupId, s.seat, s.sessionId);
        if (!res.acquired) {
          this.markStatus(
            s.sessionId,
            'paused',
            mkError('session_conflict', `lease held by ${res.conflictSessionId} on recovery`, this.now),
          );
        } else {
          this.persistLease(s.sessionId, res.lease!);
          this.markStatus(s.sessionId, s.status === 'paused' ? 'paused' : 'running', null);
        }
      } catch (err) {
        this.markStatus(s.sessionId, 'paused', mkError('adapter_error', errMsg(err), this.now));
      }
    }
    this.scheduleLoop(0);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.heartbeatTimer = null;
    this.loopTimer = null;
    for (const sb of this.sandboxes.values()) {
      await sb.dispose().catch(() => {});
    }
    this.sandboxes.clear();
  }

  private housekeeping(): void {
    this.leases.sweep();
    // Renew live leases for running sessions.
    for (const s of this.deps.store.listRecoverableSessions()) {
      if (s.status === 'running' && this.leases.isHolder(s.groupId, s.seat, s.sessionId)) {
        this.leases.renew(s.groupId, s.seat, s.sessionId);
        const peek = this.leases.peek(s.groupId, s.seat);
        if (peek) this.persistLease(s.sessionId, peek);
      }
    }
  }

  /* ----------------------- intake ----------------------- */

  /**
   * Notify the runtime that one or more groups received new messages. Called
   * from the existing group-chat ingest path (socket push + backfill). No-op
   * when no session exists for the group — zero regression to normal chat.
   */
  onGroupMessage(groupId: string): void {
    const sessions = this.deps.store.listRecoverableSessions().filter((s) => s.groupId === groupId);
    if (sessions.length === 0) return;
    for (const s of sessions) {
      void this.catchUp(s.sessionId).then(() => this.scheduleLoop(0));
    }
  }

  /* ----------------------- catch-up ----------------------- */

  /** Replay messages since the session cursor and advance state. */
  private async catchUp(sessionId: string): Promise<void> {
    const s = this.deps.store.getSession(sessionId);
    if (!s) return;
    const after = s.lastIndex < 0 ? -1 : s.lastIndex;
    const messages = this.deps.messageStore.readSince(s.groupId, after);
    if (messages.length === 0) return;
    let state = this.states.get(sessionId);
    if (state === undefined) {
      const stored = this.deps.store.getSerializedState(sessionId);
      if (stored) {
        try {
          state = JSON.parse(stored);
        } catch {
          state = undefined;
        }
      }
    }
    let cursor = s.lastIndex;
    const sandbox = this.sandboxes.get(sessionId);
    for (const msg of messages) {
      // Advance cursor for every consumed message (agent-game or not). Non-agent
      // messages are preserved by the backend but ignored here.
      const idx = msg.msgIndex ?? -1;
      if (idx >= 0) cursor = Math.max(cursor, idx);
      const env = this.tryParseEnvelope(msg.content);
      if (!env || env.protocol !== 'agent-game/1' || env.gameId !== s.gameId || env.rulesHash !== s.rulesHash) {
        continue;
      }
      if (sandbox && state !== undefined) {
        try {
          // reduce accepts only the decrypted, ordered game event (docs/07 §3).
          // Sender identity is conveyed by group-chat metadata, not the body.
          state = await sandbox.reduce(state, env as GameEvent);
        } catch (err) {
          this.log(`${sessionId}: reduce failed for ${env.eventId}: ${errMsg(err)}`);
        }
      }
      // If this action was one we had pending, it landed — clear the retry.
      if (isActionEvent(env as GameEvent)) {
        const ae = env as ActionEvent;
        const key: WriteLogKey = { groupId: s.groupId, actionSeq: ae.actionSeq, eventId: ae.eventId };
        if (this.deps.store.isWriteCommitted(key)) {
          // Already recorded by us.
        }
        const pending = this.pending.get(sessionId);
        if (pending && pending.key.eventId === ae.eventId) {
          this.pending.delete(sessionId);
        }
        if (ae.actionSeq > s.lastActionSeq) {
          s.lastActionSeq = ae.actionSeq;
        }
      }
    }
    if (state !== undefined) {
      this.states.set(sessionId, state);
    }
    s.lastIndex = cursor;
    this.persist(s, state);
  }

  /* ----------------------- action loop ----------------------- */

  private scheduleLoop(delayMs = ACTION_LOOP_DEBOUNCE_MS): void {
    if (this.disposed) return;
    if (this.loopTimer) return; // already scheduled
    this.loopTimer = setTimeout(() => {
      this.loopTimer = null;
      void this.runLoopOnce().finally(() => {
        if (!this.disposed && !this.loopTimer) this.scheduleLoop();
      });
    }, delayMs);
    this.loopTimer.unref?.();
  }

  private async runLoopOnce(): Promise<void> {
    const sessions = this.deps.store.listRecoverableSessions().filter((s) => s.status === 'running');
    for (const s of sessions) {
      if (this.busy.has(s.sessionId)) continue;
      void this.processSession(s.sessionId);
    }
  }

  private async processSession(sessionId: string): Promise<void> {
    if (this.busy.has(sessionId)) return;
    const s = this.deps.store.getSession(sessionId);
    if (!s || s.status !== 'running') return;
    if (!this.leases.isHolder(s.groupId, s.seat, s.sessionId)) {
      this.markStatus(sessionId, 'paused', mkError('session_conflict', 'lease lost', this.now));
      return;
    }
    if (this.isExpiredOrDepleted(s)) {
      this.markStatus(sessionId, 'paused', mkError('budget_exhausted', 'budget depleted or authorization expired', this.now));
      return;
    }
    const sandbox = this.sandboxes.get(sessionId);
    if (!sandbox) return;
    this.busy.add(sessionId);
    try {
      const state = this.states.get(sessionId);
      if (state === undefined) return;
      // First: retry any pending write.
      if (this.pending.has(sessionId)) {
        await this.retryPendingWrite(s);
        return;
      }
      const turn = await sandbox.getTurn(state);
      if (turn.phase === 'finished') {
        await this.finish(s);
        return;
      }
      if (turn.phase !== 'playing' || turn.seat !== s.seat) return;

      // Generate a candidate action via the host LLM (≤ N parse attempts).
      const observation = await sandbox.getObservation(state, s.seat);
      const schema = await sandbox.getActionSchema(state, s.seat);
      let action: unknown = null;
      let lastError: string | undefined;
      for (let attempt = 1; attempt <= LLM_MAX_PARSE_ATTEMPTS; attempt++) {
        let text: string;
        try {
          const result = await this.deps.llmComplete(buildMovePrompt({
            gameId: s.gameId, seat: s.seat, observation, schema, lastError,
          }), { timeoutMs: LLM_CALL_TIMEOUT_MS });
          text = result.content?.trim() ?? '';
        } catch (err) {
          this.markStatus(sessionId, 'paused', mkError(isAbort(err) ? 'llm_timeout' : 'llm_unavailable', errMsg(err), this.now));
          return;
        }
        s.budget.llmCallsUsed++;
        const parsed = await sandbox.parseAction(text, { schema, observation, seat: s.seat });
        if (!parsed.error) {
          action = parsed.action;
          break;
        }
        lastError = parsed.error;
      }
      if (action === null) {
        this.markStatus(sessionId, 'paused', mkError('llm_unavailable', 'LLM produced no valid action after retries', this.now));
        return;
      }
      const validated = await sandbox.validateAction(state, action, { schema, observation, seat: s.seat });
      if (!validated.valid) {
        this.log(`${sessionId}: action rejected by adapter (${validated.code})`);
        return; // not fatal — try again next tick
      }

      // State hashing via draft reduce clone (deterministic).
      const prevStateHash = this.hashOf(await sandbox.serializeState(state));
      const draft = structuredClone(state);
      const actionSeq = s.lastActionSeq + 1;
      const draftEvent = this.draftEnvelope(s, actionSeq, prevStateHash, validated.normalizedAction ?? action);
      const reducedDraft = await sandbox.reduce(draft, draftEvent as GameEvent);
      const stateHash = this.hashOf(await sandbox.serializeState(reducedDraft));

      const event: ActionEvent = {
        ...draftEvent,
        stateHash,
      };
      const key: WriteLogKey = { groupId: s.groupId, actionSeq, eventId: event.eventId };
      // Record intent BEFORE write (idempotency ledger).
      this.deps.store.recordWriteIntent(key, sessionId);
      this.deps.store.audit('action-write', sessionId, s.agentId, { actionSeq, eventId: event.eventId });
      this.pending.set(sessionId, { event, key });
      await this.retryPendingWrite(s);
    } catch (err) {
      if (err instanceof AdapterError) {
        this.markStatus(sessionId, 'paused', mkError(err.code, err.message, this.now));
      } else {
        this.markStatus(sessionId, 'error', mkError('internal_error', errMsg(err), this.now));
      }
    } finally {
      this.busy.delete(sessionId);
    }
  }

  /** Attempt the pending write; on failure back off; on success advance state. */
  private async retryPendingWrite(s: GameSession): Promise<void> {
    const pending = this.pending.get(s.sessionId);
    if (!pending) return;
    const { event, key } = pending;
    // If history shows it already landed, just clear + advance.
    await this.catchUp(s.sessionId);
    if (!this.pending.has(s.sessionId)) return; // cleared by catch-up
    const entry = this.deps.store.getWriteLogEntry(key);
    const attempt = entry?.attempts ?? 0;
    try {
      const plaintext = JSON.stringify(event);
      const { pinId } = await this.deps.chainWrite(s.groupId, plaintext);
      s.budget.writesUsed++;
      this.deps.store.markWriteStatus(key, 'committed', { pinId });
      // Advance local state by reducing the event into the working state.
      const state = this.states.get(s.sessionId);
      const sandbox = this.sandboxes.get(s.sessionId);
      if (state !== undefined && sandbox) {
        try {
          this.states.set(s.sessionId, await sandbox.reduce(state, event as GameEvent));
        } catch (err) {
          this.log(`${s.sessionId}: post-write reduce failed: ${errMsg(err)}`);
        }
      }
      s.lastActionSeq = event.actionSeq;
      this.pending.delete(s.sessionId);
      this.persist(s, this.states.get(s.sessionId));
      this.log(`${s.sessionId}: committed action ${event.actionSeq} (pin ${pinId.slice(0, 12)}…)`);
    } catch (err) {
      const backoff = WRITE_BACKOFF_MS[Math.min(attempt, WRITE_BACKOFF_MS.length - 1)];
      this.deps.store.markWriteStatus(key, 'failed', { error: errMsg(err) });
      this.log(`${s.sessionId}: write attempt ${attempt + 1} failed, backing off ${backoff}ms: ${errMsg(err)}`);
      await sleep(backoff);
      // Re-check history once more in case it actually landed.
      await this.catchUp(s.sessionId);
      if (this.pending.has(s.sessionId)) {
        // Still pending — schedule another loop pass to retry (bounded by budget).
        this.scheduleLoop(WRITE_BACKOFF_MS[0]);
      }
    }
  }

  private async finish(s: GameSession): Promise<void> {
    this.leases.release(s.groupId, s.seat, s.sessionId);
    this.markStatus(s.sessionId, 'finished', null);
    this.deps.store.audit('match-finished', s.sessionId, s.agentId, {});
    this.log(`${s.sessionId}: match finished, lease released`);
  }

  /* ----------------------- session API ----------------------- */

  async start(params: SessionStartParams, consent: SessionConsent): Promise<SessionView> {
    const manifest = await this.deps.manifestFetch(params.manifestUri);
    if (manifest.protocol !== 'agent-game/1') {
      throw runtimeError('adapter_invalid', `unsupported protocol ${manifest.protocol}`);
    }
    if (manifest.gameId !== params.gameId) {
      throw runtimeError('adapter_invalid', `manifest gameId ${manifest.gameId} != ${params.gameId}`);
    }
    const adapterPath = this.deps.adapterPathFor(params.manifestUri, manifest);
    const sandbox = await loadAdapterSandbox(adapterPath, manifest.adapterHash);
    await sandbox.smokeTest({ gameId: params.gameId, seat: params.seat });

    const now = this.now();
    const sessionId = randomUUID();

    // Lease conflict → session_conflict. Lease is held by the sessionId.
    const res = this.leases.acquire(params.groupId, params.seat, sessionId);
    if (!res.acquired) {
      await sandbox.dispose();
      throw runtimeError('session_conflict', `seat ${params.seat} held by ${res.conflictSessionId}`);
    }
    const budget: SessionBudget = { llmCalls: params.budget.llmCalls, llmCallsUsed: 0, writes: params.budget.writes, writesUsed: 0 };
    const session: GameSession = {
      sessionId,
      status: 'running',
      appId: params.appId,
      groupId: params.groupId,
      gameId: params.gameId,
      agentId: params.agentId,
      seat: params.seat,
      rulesHash: params.rulesHash,
      adapterHash: manifest.adapterHash,
      manifestUri: params.manifestUri,
      protocolPaths: params.protocolPaths ?? ['/protocols/simplegroupchat'],
      budget,
      lastIndex: -1,
      lastActionSeq: 0,
      lastError: null,
      expiresAt: now + params.ttlMs,
      consent,
      leaseId: res.lease!.leaseId,
      leaseExpiresAt: res.lease!.expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    this.sandboxes.set(sessionId, sandbox);
    this.deps.store.upsertGrant(consent);
    const initialState = await sandbox.initialState({ gameId: params.gameId, seat: params.seat });
    this.states.set(sessionId, initialState);
    this.deps.store.upsertSession(session, JSON.stringify(initialState));
    this.deps.store.audit('session-start', sessionId, params.agentId, { groupId: params.groupId, gameId: params.gameId, seat: params.seat });
    this.emit('sessionUpdated', session);
    this.scheduleLoop(0);
    return toSessionView(session);
  }

  async status(sessionId: string): Promise<SessionView> {
    const s = this.deps.store.getSession(sessionId);
    if (!s) throw runtimeError('session_not_found', `unknown session ${sessionId}`);
    return toSessionView(s);
  }

  list(actorId: string, opts: { appId?: string; status?: SessionStatus; groupId?: string }): SessionView[] {
    return this.deps.store.listSessions({ agentId: actorId, ...opts }).map(toSessionView);
  }

  async pause(sessionId: string): Promise<SessionView> {
    const s = this.deps.store.getSession(sessionId);
    if (!s) throw runtimeError('session_not_found', `unknown session ${sessionId}`);
    if (s.status === 'paused' || s.status === 'stopped' || s.status === 'finished') return toSessionView(s);
    this.markStatus(sessionId, 'paused', null); // pause keeps the lease
    return toSessionView(this.deps.store.getSession(sessionId)!);
  }

  async resume(sessionId: string): Promise<SessionView> {
    const s = this.deps.store.getSession(sessionId);
    if (!s) throw runtimeError('session_not_found', `unknown session ${sessionId}`);
    if (s.status === 'finished') return toSessionView(s);
    await this.ensureSandbox(s);
    await this.catchUp(sessionId);
    const res = this.leases.acquire(s.groupId, s.seat, sessionId);
    if (!res.acquired) {
      this.markStatus(sessionId, 'paused', mkError('session_conflict', `lease held by ${res.conflictSessionId}`, this.now));
      return toSessionView(this.deps.store.getSession(sessionId)!);
    }
    this.persistLease(sessionId, res.lease!);
    this.markStatus(sessionId, 'running', null);
    this.scheduleLoop(0);
    return toSessionView(this.deps.store.getSession(sessionId)!);
  }

  async stop(sessionId: string, _releaseSeat?: boolean): Promise<SessionView> {
    const s = this.deps.store.getSession(sessionId);
    if (!s) throw runtimeError('session_not_found', `unknown session ${sessionId}`);
    if (s.status === 'stopped' || s.status === 'finished') return toSessionView(s);
    this.pending.delete(sessionId);
    this.leases.releaseSession(sessionId);
    const sb = this.sandboxes.get(sessionId);
    if (sb) {
      await sb.dispose().catch(() => {});
      this.sandboxes.delete(sessionId);
    }
    this.markStatus(sessionId, 'stopped', null);
    this.deps.store.audit('session-stop', sessionId, s.agentId, {});
    return toSessionView(this.deps.store.getSession(sessionId)!);
  }

  /** Revoke a session's authorization (manual). */
  revokeConsent(sessionId: string, reason: string): SessionView {
    const s = this.deps.store.getSession(sessionId);
    if (!s) throw runtimeError('session_not_found', `unknown session ${sessionId}`);
    if (s.consent) {
      this.deps.store.revokeGrant({
        resourceUri: s.consent.resourceUri, actorId: s.consent.actorId, appId: s.consent.appId,
        groupId: s.consent.groupId, gameId: s.consent.gameId, rulesHash: s.consent.rulesHash,
        adapterHash: s.consent.adapterHash, seat: s.consent.seat,
      }, reason);
    }
    this.markStatus(sessionId, 'paused', mkError('consent_denied', `consent revoked: ${reason}`, this.now));
    return toSessionView(this.deps.store.getSession(sessionId)!);
  }

  /* ----------------------- helpers ----------------------- */

  private async ensureSandbox(s: GameSession): Promise<void> {
    if (this.sandboxes.has(s.sessionId)) return;
    const manifest = await this.deps.manifestFetch(s.manifestUri);
    const adapterPath = this.deps.adapterPathFor(s.manifestUri, manifest);
    const sandbox = await loadAdapterSandbox(adapterPath, s.adapterHash);
    await sandbox.smokeTest({ gameId: s.gameId, seat: s.seat });
    this.sandboxes.set(s.sessionId, sandbox);
    if (!this.states.has(s.sessionId)) {
      this.states.set(s.sessionId, await sandbox.initialState({ gameId: s.gameId, seat: s.seat }));
    }
  }

  private isExpiredOrDepleted(s: GameSession): boolean {
    if (s.expiresAt > 0 && s.expiresAt <= this.now()) return true;
    if (s.budget.llmCalls > 0 && s.budget.llmCallsUsed >= s.budget.llmCalls) return true;
    if (s.budget.writes > 0 && s.budget.writesUsed >= s.budget.writes) return true;
    return false;
  }

  private markStatus(sessionId: string, status: SessionStatus, err: SessionError | null): void {
    const s = this.deps.store.getSession(sessionId);
    if (!s) return;
    s.status = status;
    s.lastError = err;
    s.updatedAt = this.now();
    this.deps.store.upsertSession(s, this.deps.store.getSerializedState(sessionId) ?? undefined);
    this.emit('sessionUpdated', s);
  }

  private persist(s: GameSession, state: unknown): void {
    s.updatedAt = this.now();
    let serialized: string | undefined;
    if (state !== undefined) {
      try {
        serialized = JSON.stringify(state);
        this.states.set(s.sessionId, state);
      } catch {
        serialized = undefined;
      }
    }
    this.deps.store.upsertSession(s, serialized);
    this.emit('sessionUpdated', s);
  }

  private persistLease(sessionId: string, lease: { leaseId: string; expiresAt: number }): void {
    const s = this.deps.store.getSession(sessionId);
    if (!s) return;
    s.leaseId = lease.leaseId;
    s.leaseExpiresAt = lease.expiresAt;
    this.deps.store.upsertSession(s, this.deps.store.getSerializedState(sessionId) ?? undefined);
  }

  private tryParseEnvelope(content: string): GameEvent | null {
    try {
      const env = JSON.parse(content);
      if (env && typeof env === 'object' && env.protocol === 'agent-game/1') {
        return env as GameEvent;
      }
    } catch {
      // not JSON / not an agent-game envelope — ignore
    }
    return null;
  }

  private draftEnvelope(
    s: GameSession,
    actionSeq: number,
    prevStateHash: string,
    payload: unknown,
  ): ActionEvent {
    return {
      protocol: 'agent-game/1',
      gameId: s.gameId,
      matchId: s.groupId,
      rulesHash: s.rulesHash,
      type: 'action',
      eventId: `${s.agentId}:${randomUUID()}`,
      actionSeq,
      prevStateHash,
      stateHash: '', // filled after draft reduce
      payload: (payload as Record<string, unknown>) ?? {},
    };
  }

  private hashOf(serialized: string): string {
    return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

export class RuntimeError extends Error {
  constructor(public readonly code: SessionErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}

function runtimeError(code: SessionErrorCode, message: string): RuntimeError {
  return new RuntimeError(code, message);
}

function isAbort(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name;
  return name === 'AbortError' || name === 'BrowserLlmTimeout';
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Build a SessionError with the current timestamp. */
function mkError(code: SessionErrorCode, message: string, now: () => number): SessionError {
  return { code, message, at: now() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}
