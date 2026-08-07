/**
 * Task-level authorization (docs/14 §3).
 *
 * `start` pops a consent card (actor, MetaApp/appId, groupId, gameId,
 * rules/Adapter hash, protocol paths, TTL, budget). Deny → `consent_denied`.
 * Approval binds a grant keyed by resourceUri+actorId+appId+groupId+gameId+
 * rulesHash+adapterHash+seat, persisted (revocable, expiring). Auto-writes are
 * allowed only for pins whose `path` ∈ authorized `protocolPaths`; everything
 * else still routes through the existing manual confirmation. Authorization
 * and writes are recorded in the audit log.
 *
 * Composes with — does not bypass — botBrowserBridgeService validation:
 * "命中授权时跳过人工确认但绝不过校验".
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { AgentGameSessionStore } from './sessionStore';
import type {
  GameManifest,
  SessionBudget,
  SessionConsent,
  SessionStartParams,
} from './abi';

/** What the consent card renders to the user. */
export interface ConsentCardInfo {
  requestId: string;
  actor: string;
  appId: string;
  groupId: string;
  gameId: string;
  seat: string;
  resourceUri: string;
  rulesHash: string;
  adapterHash: string;
  manifestUri: string;
  protocolPaths: string[];
  ttlMs: number;
  budget: { llmCalls: number; writes: number };
}

export type ConsentDecision = { approved: true; consent: SessionConsent } | { approved: false; reason: string };

export interface ConsentManagerDeps {
  store: AgentGameSessionStore;
  /** Build a resourceUri that scopes the grant (e.g. the MetaApp origin). */
  resourceUriFor: (params: SessionStartParams, manifest: GameManifest) => string;
  /** Resolve the actor globalMetaId at request time (browser.actor.current). */
  resolveActor: () => string;
  /** Resolve a display name for the adapter (for the card). */
  adapterLabel?: (manifest: GameManifest) => string;
  now?: () => number;
  log?: (msg: string) => void;
}

export class ConsentManager extends EventEmitter {
  private pending = new Map<string, { resolve: (d: ConsentDecision) => void; info: ConsentCardInfo }>();
  private readonly now: () => number;

  constructor(private deps: ConsentManagerDeps) {
    super();
    this.now = deps.now ?? Date.now;
  }

  private log(msg: string): void {
    this.deps.log?.(`[agent-game-consent] ${msg}`);
  }

  /**
   * Request authorization for a start call. Emits `consentRequired` (renderer
   * surfaces the card) and resolves once the user responds via `respond`.
   * Resolves with consent_denied-style decision on reject.
   */
  requestAuthorization(params: SessionStartParams, manifest: GameManifest): Promise<ConsentDecision> {
    const requestId = randomUUID();
    const actor = params.agentId || this.deps.resolveActor();
    const resourceUri = this.deps.resourceUriFor(params, manifest);
    const protocolPaths = params.protocolPaths ?? ['/protocols/simplegroupchat'];
    const info: ConsentCardInfo = {
      requestId,
      actor,
      appId: params.appId,
      groupId: params.groupId,
      gameId: params.gameId,
      seat: params.seat,
      resourceUri,
      rulesHash: params.rulesHash,
      adapterHash: manifest.adapterHash,
      manifestUri: params.manifestUri,
      protocolPaths,
      ttlMs: params.ttlMs,
      budget: params.budget,
    };
    return new Promise((resolve) => {
      this.pending.set(requestId, { resolve, info });
      this.emit('consentRequired', info);
      this.log(`authorization requested for ${params.gameId}/${params.seat} in ${params.groupId}`);
    });
  }

  /** User response from the renderer (approve/deny). */
  respond(requestId: string, approved: boolean, reason?: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    const info = entry.info;
    if (!approved) {
      this.deps.store.audit('consent-denied', null, info.actor, { requestId, gameId: info.gameId, reason: reason ?? 'denied' });
      entry.resolve({ approved: false, reason: reason ?? 'denied' });
      this.log(`authorization denied for ${info.gameId}/${info.groupId}`);
      return;
    }
    const now = this.now();
    const budget: SessionBudget = {
      llmCalls: info.budget.llmCalls,
      llmCallsUsed: 0,
      writes: info.budget.writes,
      writesUsed: 0,
    };
    const consent: SessionConsent = {
      actorId: info.actor,
      appId: info.appId,
      groupId: info.groupId,
      gameId: info.gameId,
      rulesHash: info.rulesHash,
      adapterHash: info.adapterHash,
      seat: info.seat,
      resourceUri: info.resourceUri,
      protocolPaths: info.protocolPaths,
      ttlMs: info.ttlMs,
      budget,
      grantedAt: now,
    };
    this.deps.store.audit('consent-granted', null, info.actor, { requestId, gameId: info.gameId, ttlMs: info.ttlMs });
    entry.resolve({ approved: true, consent });
    this.log(`authorization granted for ${info.gameId}/${info.groupId}`);
  }

  /** Drop a pending request (e.g. on timeout / app close). */
  cancel(requestId: string, reason: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    entry.resolve({ approved: false, reason });
  }

  /** Pending card infos (for renderer re-hydration after a refresh). */
  listPending(): ConsentCardInfo[] {
    return [...this.pending.values()].map((e) => e.info);
  }

  /**
   * Is an auto-write authorized (skip manual confirmation)? Composes with the
   * bridge: the bridge still validates the pin payload; this only decides
   * whether a prior grant covers it. The caller computes resourceUri with the
   * same resourceUriFor used at grant time.
   */
  isAutoWriteAuthorized(args: {
    resourceUri: string;
    actorId: string;
    appId: string;
    groupId: string;
    gameId: string;
    rulesHash: string;
    adapterHash: string;
    seat: string;
    protocolPath: string;
  }): boolean {
    // Must be an exact /protocols/<name> path AND present in the grant's
    // authorized protocolPaths. Anything else needs manual confirmation.
    if (!/^\/protocols\/[A-Za-z0-9_-]+$/.test(args.protocolPath)) return false;
    const grant = this.deps.store.getGrant({
      resourceUri: args.resourceUri,
      actorId: args.actorId,
      appId: args.appId,
      groupId: args.groupId,
      gameId: args.gameId,
      rulesHash: args.rulesHash,
      adapterHash: args.adapterHash,
      seat: args.seat,
    });
    if (!grant || grant.status !== 'active') return false;
    if (grant.expiresAt > 0 && grant.expiresAt <= this.now()) return false;
    if (!Array.isArray(grant.protocolPaths) || !grant.protocolPaths.includes(args.protocolPath)) return false;
    return true;
  }
}
