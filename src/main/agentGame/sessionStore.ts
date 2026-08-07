/**
 * Agent-Game-v2 persistence (docs/14 §5).
 *
 * Stores Sessions, task-level grants, the idempotent write log, and the audit
 * trail in the shared sql.js database. Tables are created idempotently by
 * sqliteStore (see `initializeAgentGameTables`) and this store owns access to
 * them. Reads/writes follow the same (db, saveDb) pattern as GroupTaskStore.
 *
 * Safety: these tables are user-data; auto-update never replaces or resets
 * them. Column additions go through guarded ALTER TABLE migrations.
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import type {
  GameSession,
  SessionBudget,
  SessionConsent,
  SessionError,
  SessionStatus,
} from './abi';

/** Row shape for agent_game_sessions (stringified JSON columns decoded here). */
interface SessionRow {
  session_id: string;
  status: string;
  app_id: string;
  group_id: string;
  game_id: string;
  agent_id: string;
  seat: string;
  rules_hash: string;
  adapter_hash: string;
  manifest_uri: string;
  protocol_paths: string | null;
  budget_llm_calls: number;
  budget_llm_calls_used: number;
  budget_writes: number;
  budget_writes_used: number;
  last_index: number | null;
  last_action_seq: number;
  last_error: string | null;
  expires_at: number;
  consent: string | null;
  lease_id: string | null;
  lease_expires_at: number | null;
  serialized_state: string | null;
  created_at: number;
  updated_at: number;
}

/** Grant row shape. */
interface GrantRow {
  resource_uri: string;
  actor_id: string;
  app_id: string;
  group_id: string;
  game_id: string;
  rules_hash: string;
  adapter_hash: string;
  seat: string;
  status: string;
  ttl_ms: number;
  expires_at: number;
  budget_llm_calls: number;
  budget_writes: number;
  protocol_paths: string | null;
  revoked_at: number | null;
  reason: string | null;
  created_at: number;
}

/** Write-log row shape (idempotency ledger). */
export interface WriteLogRow {
  id: number;
  group_id: string;
  action_seq: number;
  event_id: string;
  session_id: string;
  pin_id: string | null;
  tx_id: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface WriteLogKey {
  groupId: string;
  actionSeq: number;
  eventId: string;
}

function parseStatus(s: string): SessionStatus {
  return s === 'running' || s === 'paused' || s === 'stopped' || s === 'finished' || s === 'error'
    ? s
    : 'paused';
}

function decodeBudget(r: SessionRow): SessionBudget {
  return {
    llmCalls: r.budget_llm_calls,
    llmCallsUsed: r.budget_llm_calls_used,
    writes: r.budget_writes,
    writesUsed: r.budget_writes_used,
  };
}

function rowToSession(r: SessionRow): GameSession {
  let protocolPaths: string[] = [];
  try {
    protocolPaths = r.protocol_paths ? JSON.parse(r.protocol_paths) : [];
  } catch {
    protocolPaths = [];
  }
  let consent: SessionConsent | null = null;
  try {
    consent = r.consent ? JSON.parse(r.consent) : null;
  } catch {
    consent = null;
  }
  let lastError: SessionError | null = null;
  try {
    lastError = r.last_error ? JSON.parse(r.last_error) : null;
  } catch {
    lastError = null;
  }
  return {
    sessionId: r.session_id,
    status: parseStatus(r.status),
    appId: r.app_id,
    groupId: r.group_id,
    gameId: r.game_id,
    agentId: r.agent_id,
    seat: r.seat,
    rulesHash: r.rules_hash,
    adapterHash: r.adapter_hash,
    manifestUri: r.manifest_uri,
    protocolPaths,
    budget: decodeBudget(r),
    lastIndex: typeof r.last_index === 'number' ? r.last_index : -1,
    lastActionSeq: r.last_action_seq,
    lastError,
    expiresAt: r.expires_at,
    consent,
    leaseId: r.lease_id,
    leaseExpiresAt: r.lease_expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToGrant(r: GrantRow): SessionConsent & {
  status: string;
  expiresAt: number;
  revokedAt: number | null;
  reason: string | null;
} {
  let protocolPaths: string[] = [];
  try {
    protocolPaths = r.protocol_paths ? JSON.parse(r.protocol_paths) : [];
  } catch {
    protocolPaths = [];
  }
  return {
    actorId: r.actor_id,
    appId: r.app_id,
    groupId: r.group_id,
    gameId: r.game_id,
    rulesHash: r.rules_hash,
    adapterHash: r.adapter_hash,
    seat: r.seat,
    resourceUri: r.resource_uri,
    protocolPaths,
    ttlMs: r.ttl_ms,
    budget: { llmCalls: r.budget_llm_calls, llmCallsUsed: 0, writes: r.budget_writes, writesUsed: 0 },
    grantedAt: r.created_at,
    status: r.status,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    reason: r.reason,
  };
}

export class AgentGameSessionStore {
  constructor(
    private db: Database,
    private saveDb: () => void,
  ) {}

  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values[0]) return undefined;
    const columns = result[0].columns;
    const values = result[0].values[0];
    const row: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      row[col] = values[i];
    });
    return row as T;
  }

  private getAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values) return [];
    const columns = result[0].columns;
    return result[0].values.map((values) => {
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = values[i];
      });
      return row as T;
    });
  }

  /* ----------------------------- Sessions ----------------------------- */

  upsertSession(s: GameSession, serializedState?: string): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO agent_game_sessions (
        session_id, status, app_id, group_id, game_id, agent_id, seat, rules_hash,
        adapter_hash, manifest_uri, protocol_paths, budget_llm_calls, budget_llm_calls_used,
        budget_writes, budget_writes_used, last_index, last_action_seq, last_error, expires_at,
        consent, lease_id, lease_expires_at, serialized_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        status=excluded.status, app_id=excluded.app_id, group_id=excluded.group_id,
        game_id=excluded.game_id, agent_id=excluded.agent_id, seat=excluded.seat,
        rules_hash=excluded.rules_hash, adapter_hash=excluded.adapter_hash,
        manifest_uri=excluded.manifest_uri, protocol_paths=excluded.protocol_paths,
        budget_llm_calls=excluded.budget_llm_calls,
        budget_llm_calls_used=excluded.budget_llm_calls_used,
        budget_writes=excluded.budget_writes, budget_writes_used=excluded.budget_writes_used,
        last_index=excluded.last_index, last_action_seq=excluded.last_action_seq,
        last_error=excluded.last_error, expires_at=excluded.expires_at, consent=excluded.consent,
        lease_id=excluded.lease_id, lease_expires_at=excluded.lease_expires_at,
        serialized_state=COALESCE(excluded.serialized_state, agent_game_sessions.serialized_state),
        updated_at=excluded.updated_at`,
      [
        s.sessionId, s.status, s.appId, s.groupId, s.gameId, s.agentId, s.seat, s.rulesHash,
        s.adapterHash, s.manifestUri, JSON.stringify(s.protocolPaths),
        s.budget.llmCalls, s.budget.llmCallsUsed, s.budget.writes, s.budget.writesUsed,
        s.lastIndex, s.lastActionSeq, s.lastError ? JSON.stringify(s.lastError) : null, s.expiresAt,
        s.consent ? JSON.stringify(s.consent) : null, s.leaseId, s.leaseExpiresAt,
        serializedState ?? null, s.createdAt || now, now,
      ],
    );
    this.saveDb();
  }

  getSession(sessionId: string): GameSession | undefined {
    const row = this.getOne<SessionRow>(
      'SELECT * FROM agent_game_sessions WHERE session_id = ?',
      [sessionId],
    );
    return row ? rowToSession(row) : undefined;
  }

  /** Sessions the actor may view, optionally filtered. */
  listSessions(opts: { agentId: string; appId?: string; status?: SessionStatus; groupId?: string }): GameSession[] {
    const where: string[] = ['agent_id = ?'];
    const params: (string | number | null)[] = [opts.agentId];
    if (opts.appId) {
      where.push('app_id = ?');
      params.push(opts.appId);
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.groupId) {
      where.push('group_id = ?');
      params.push(opts.groupId);
    }
    const rows = this.getAll<SessionRow>(
      `SELECT * FROM agent_game_sessions WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`,
      params,
    );
    return rows.map(rowToSession);
  }

  /** Unfinished sessions eligible for recovery on host restart. */
  listRecoverableSessions(): GameSession[] {
    const rows = this.getAll<SessionRow>(
      `SELECT * FROM agent_game_sessions WHERE status IN ('running','paused') ORDER BY created_at ASC`,
    );
    return rows.map(rowToSession);
  }

  /** Active game groups — fed into the group-chat backfill active set. */
  listActiveGroupIds(): string[] {
    const rows = this.getAll<{ group_id: string }>(
      `SELECT DISTINCT group_id FROM agent_game_sessions WHERE status IN ('running','paused')`,
    );
    return rows.map((r) => r.group_id);
  }

  getSerializedState(sessionId: string): string | null {
    const row = this.getOne<{ serialized_state: string | null }>(
      'SELECT serialized_state FROM agent_game_sessions WHERE session_id = ?',
      [sessionId],
    );
    return row?.serialized_state ?? null;
  }

  deleteSession(sessionId: string): void {
    this.db.run('DELETE FROM agent_game_sessions WHERE session_id = ?', [sessionId]);
    this.saveDb();
  }

  /* ------------------------------ Grants ------------------------------ */

  upsertGrant(g: SessionConsent): void {
    const now = Date.now();
    const createdAt = g.grantedAt || now;
    const expiresAt = createdAt + g.ttlMs;
    this.db.run(
      `INSERT INTO agent_game_grants (
        resource_uri, actor_id, app_id, group_id, game_id, rules_hash, adapter_hash, seat,
        status, ttl_ms, expires_at, budget_llm_calls, budget_writes, protocol_paths, revoked_at, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(resource_uri, actor_id, app_id, group_id, game_id, rules_hash, adapter_hash, seat)
      DO UPDATE SET status='active', ttl_ms=excluded.ttl_ms, expires_at=excluded.expires_at,
        budget_llm_calls=excluded.budget_llm_calls, budget_writes=excluded.budget_writes,
        protocol_paths=excluded.protocol_paths, revoked_at=NULL, reason=NULL`,
      [
        g.resourceUri, g.actorId, g.appId, g.groupId, g.gameId, g.rulesHash, g.adapterHash, g.seat,
        g.ttlMs, expiresAt, g.budget.llmCalls, g.budget.writes, JSON.stringify(g.protocolPaths ?? []),
        createdAt,
      ],
    );
    this.saveDb();
  }

  getGrant(key: {
    resourceUri: string;
    actorId: string;
    appId: string;
    groupId: string;
    gameId: string;
    rulesHash: string;
    adapterHash: string;
    seat: string;
  }): (SessionConsent & { status: string; expiresAt: number; revokedAt: number | null; reason: string | null }) | undefined {
    const row = this.getOne<GrantRow>(
      `SELECT * FROM agent_game_grants WHERE resource_uri=? AND actor_id=? AND app_id=? AND group_id=?
       AND game_id=? AND rules_hash=? AND adapter_hash=? AND seat=?`,
      [
        key.resourceUri, key.actorId, key.appId, key.groupId, key.gameId,
        key.rulesHash, key.adapterHash, key.seat,
      ],
    );
    return row ? rowToGrant(row) : undefined;
  }

  revokeGrant(key: {
    resourceUri: string;
    actorId: string;
    appId: string;
    groupId: string;
    gameId: string;
    rulesHash: string;
    adapterHash: string;
    seat: string;
  }, reason: string): void {
    this.db.run(
      `UPDATE agent_game_grants SET status='revoked', revoked_at=?, reason=? WHERE
       resource_uri=? AND actor_id=? AND app_id=? AND group_id=? AND game_id=? AND rules_hash=?
       AND adapter_hash=? AND seat=?`,
      [
        Date.now(), reason,
        key.resourceUri, key.actorId, key.appId, key.groupId, key.gameId,
        key.rulesHash, key.adapterHash, key.seat,
      ],
    );
    this.saveDb();
  }

  /* --------------------------- Write log ------------------------------ */

  /** Record intent to write BEFORE the chain write (idempotency ledger). */
  recordWriteIntent(key: WriteLogKey, sessionId: string): void {
    this.db.run(
      `INSERT OR IGNORE INTO agent_game_write_log
        (group_id, action_seq, event_id, session_id, pin_id, tx_id, status, attempts, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, 'pending', 0, NULL, ?, ?)`,
      [key.groupId, key.actionSeq, key.eventId, sessionId, Date.now(), Date.now()],
    );
    this.saveDb();
  }

  getWriteLogEntry(key: WriteLogKey): WriteLogRow | undefined {
    return this.getOne<WriteLogRow>(
      `SELECT * FROM agent_game_write_log WHERE group_id=? AND action_seq=? AND event_id=?`,
      [key.groupId, key.actionSeq, key.eventId],
    );
  }

  /** Has this event already been committed on-chain? */
  isWriteCommitted(key: WriteLogKey): boolean {
    const row = this.getWriteLogEntry(key);
    return !!row && row.status === 'committed';
  }

  markWriteStatus(
    key: WriteLogKey,
    status: WriteLogRow['status'],
    details: { pinId?: string | null; txId?: string | null; error?: string | null },
  ): void {
    const now = Date.now();
    this.db.run(
      `UPDATE agent_game_write_log SET status=?, pin_id=COALESCE(?, pin_id), tx_id=COALESCE(?, tx_id),
       last_error=?, attempts=attempts+1, updated_at=? WHERE group_id=? AND action_seq=? AND event_id=?`,
      [
        status, details.pinId ?? null, details.txId ?? null, details.error ?? null, now,
        key.groupId, key.actionSeq, key.eventId,
      ],
    );
    this.saveDb();
  }

  /* ----------------------------- Audit -------------------------------- */

  audit(type: string, sessionId: string | null, actorId: string | null, fields: Record<string, unknown>): void {
    this.db.run(
      `INSERT INTO agent_game_audit (type, session_id, actor_id, fields, ts)
       VALUES (?, ?, ?, ?, ?)`,
      [type, sessionId, actorId, JSON.stringify(fields), Date.now()],
    );
    this.saveDb();
  }
}
