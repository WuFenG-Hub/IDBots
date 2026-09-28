import type { SqliteDatabase as Database } from '../../sqliteTypes';
import { H_ACT2, type MetaTaskEventPath } from './constants';
import type {
  MetaTaskAlert,
  MetaTaskBoard,
  MetaTaskBoardTask,
  MetaTaskChainEvent,
  MetaTaskIdentity,
  MetaTaskTaskProjection,
} from './types';

interface Row {
  [column: string]: unknown;
}

/** Resolves display identities for metaIds (local roster now; MetaSo later). */
export type MetaTaskIdentityResolver = (metaIds: string[]) => Promise<Record<string, MetaTaskIdentity>>;

/**
 * MetaTask projection cache (P1 read path). These tables are REBUILDABLE
 * caches of the chain replay — never a task entity of record ("referenced,
 * not mixed in" boundary from the long-term-task redesign). Dropping all
 * tables and re-running the refresher reproduces identical content.
 */
export class MetaTaskProjectionStore {
  private readonly db: Database;
  private readonly saveDb: () => void;
  private readonly resolveIdentities?: MetaTaskIdentityResolver;

  constructor(db: Database, saveDb: () => void, options?: { resolveIdentities?: MetaTaskIdentityResolver }) {
    this.db = db;
    this.saveDb = saveDb;
    this.resolveIdentities = options?.resolveIdentities;
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metatask_events (
        pin_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        height INTEGER NOT NULL DEFAULT -1,
        tx_index INTEGER NOT NULL DEFAULT 0,
        timestamp_ms INTEGER NOT NULL DEFAULT 0,
        content_json TEXT NOT NULL DEFAULT '{}',
        collected_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metatask_events_path
        ON metatask_events(path, height);
      CREATE TABLE IF NOT EXISTS metatask_task_projections (
        root_pin_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        publisher TEXT NOT NULL DEFAULT '',
        task_complete INTEGER NOT NULL DEFAULT 0,
        verified INTEGER NOT NULL DEFAULT 0,
        claimed INTEGER NOT NULL DEFAULT 0,
        open INTEGER NOT NULL DEFAULT 0,
        disputed INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        participant_count INTEGER NOT NULL DEFAULT 0,
        last_activity_ms INTEGER NOT NULL DEFAULT 0,
        boundary_block INTEGER NOT NULL DEFAULT -1,
        event_count INTEGER NOT NULL DEFAULT 0,
        event_set_hash TEXT NOT NULL DEFAULT '',
        settlement_json TEXT,
        projection_json TEXT NOT NULL DEFAULT '{}',
        refreshed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metatask_refresh_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_refresh_at TEXT,
        last_ok_at TEXT,
        last_error TEXT,
        boundary_block INTEGER NOT NULL DEFAULT -1,
        refreshing INTEGER NOT NULL DEFAULT 0,
        seq INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO metatask_refresh_state (id) VALUES (1);
      CREATE TABLE IF NOT EXISTS metatask_watch_state (
        task_root TEXT NOT NULL,
        node_id TEXT NOT NULL,
        last_status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_root, node_id)
      );
      CREATE TABLE IF NOT EXISTS metatask_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        root_pin_id TEXT NOT NULL,
        node_id TEXT,
        detail TEXT,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metatask_alerts_id ON metatask_alerts(id DESC);
      CREATE TABLE IF NOT EXISTS metatask_identities (
        meta_id TEXT PRIMARY KEY,
        name TEXT,
        avatar TEXT,
        source TEXT NOT NULL DEFAULT 'local',
        resolved_at TEXT NOT NULL
      );
    `);
    this.saveDb();
  }

  private getAll<T extends object>(sql: string, params: unknown[] = []): T[] {
    const result = this.db.exec(sql, params);
    return (result[0]?.values ?? []).map((values) => {
      const row: Row = {};
      result[0].columns.forEach((column, index) => {
        row[column] = values[index];
      });
      return row as T;
    });
  }

  private getOne<T extends object>(sql: string, params: unknown[] = []): T | null {
    const rows = this.getAll<T>(sql, params);
    return rows[0] ?? null;
  }

  // ── event cache ────────────────────────────────────────────────────────────

  upsertEvents(events: MetaTaskChainEvent[]): number {
    const now = new Date().toISOString();
    let written = 0;
    for (const event of events) {
      this.db.run(
        `INSERT INTO metatask_events
           (pin_id, path, author, height, tx_index, timestamp_ms, content_json, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pin_id) DO UPDATE SET
           path = excluded.path,
           author = excluded.author,
           height = excluded.height,
           tx_index = excluded.tx_index,
           timestamp_ms = excluded.timestamp_ms,
           content_json = excluded.content_json,
           collected_at = excluded.collected_at`,
        [
          event.pinId,
          event.path,
          event.author,
          event.height,
          event.txIndex,
          event.timestampMs,
          JSON.stringify(event.body),
          now,
        ]
      );
      written += 1;
    }
    if (written > 0) this.saveDb();
    return written;
  }

  loadEvents(): MetaTaskChainEvent[] {
    return this.getAll<Row>('SELECT pin_id, path, author, height, tx_index, timestamp_ms, content_json FROM metatask_events').map(
      (row) => {
        let body: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(String(row.content_json ?? '{}'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            body = parsed as Record<string, unknown>;
          }
        } catch {
          body = {};
        }
        return {
          pinId: String(row.pin_id),
          path: String(row.path) as MetaTaskEventPath,
          author: String(row.author ?? ''),
          height: Number(row.height ?? -1),
          txIndex: Number(row.tx_index ?? 0),
          timestampMs: Number(row.timestamp_ms ?? 0),
          body,
        };
      }
    );
  }

  // ── projections ────────────────────────────────────────────────────────────

  /** Every metaId a projection displays (publisher, participants, node actors, voters). */
  private static actorsOf(projection: MetaTaskTaskProjection): Set<string> {
    const actors = new Set<string>([projection.publisher]);
    for (const participant of projection.participants) actors.add(participant.metaId);
    for (const node of Object.values(projection.nodeStates)) {
      if (node.holder) actors.add(node.holder.claimant);
      if (node.submission) actors.add(node.submission.submitter);
      for (const vote of node.votes) actors.add(vote.voter);
    }
    if (projection.settlement) {
      for (const share of projection.settlement.shares) actors.add(share.metaId);
    }
    actors.delete('');
    return actors;
  }

  /**
   * Resolve display identities for every actor and stamp them onto the
   * projections before persisting (single enrichment point). The injected
   * resolver is local-roster-first with a throttled remote fallback; resolved
   * rows persist in metatask_identities so later sweeps serve them from cache.
   */
  async enrichIdentities(projections: MetaTaskTaskProjection[]): Promise<void> {
    const actors = new Set<string>();
    for (const projection of projections) {
      for (const actor of MetaTaskProjectionStore.actorsOf(projection)) actors.add(actor);
    }
    const merged: Record<string, MetaTaskIdentity> = {};
    for (const metaId of actors) {
      const cached = this.getIdentityRow(metaId);
      if (cached) merged[metaId] = cached;
    }
    const missing = Array.from(actors).filter((metaId) => !merged[metaId]);
    if (missing.length > 0 && this.resolveIdentities) {
      try {
        const resolved = await this.resolveIdentities(missing);
        for (const [metaId, identity] of Object.entries(resolved)) {
          merged[metaId] = identity;
          this.putIdentityRow(identity, 'local');
        }
      } catch {
        // identity enrichment is best-effort display sugar; never fail the sweep
      }
    }
    for (const projection of projections) {
      const scoped: Record<string, MetaTaskIdentity> = {};
      for (const actor of MetaTaskProjectionStore.actorsOf(projection)) {
        if (merged[actor]) scoped[actor] = merged[actor];
      }
      projection.identities = scoped;
    }
  }

  private getIdentityRow(metaId: string): MetaTaskIdentity | null {
    const row = this.getOne<Row>('SELECT meta_id, name, avatar FROM metatask_identities WHERE meta_id = ?', [metaId]);
    if (!row) return null;
    return { metaId, name: row.name === null ? null : String(row.name), avatar: row.avatar === null ? null : String(row.avatar) };
  }

  private putIdentityRow(identity: MetaTaskIdentity, source: string): void {
    this.db.run(
      `INSERT INTO metatask_identities (meta_id, name, avatar, source, resolved_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(meta_id) DO UPDATE SET
         name = COALESCE(excluded.name, metatask_identities.name),
         avatar = COALESCE(excluded.avatar, metatask_identities.avatar),
         resolved_at = excluded.resolved_at`,
      [identity.metaId, identity.name, identity.avatar, source, new Date().toISOString()]
    );
    this.saveDb();
  }

  saveProjections(projections: MetaTaskTaskProjection[]): void {
    const now = new Date().toISOString();
    const keep = new Set(projections.map((projection) => projection.rootPinId));
    for (const projection of projections) {
      this.db.run(
        `INSERT INTO metatask_task_projections
           (root_pin_id, title, publisher, task_complete, verified, claimed, open, disputed,
            total, participant_count, last_activity_ms, boundary_block, event_count,
            event_set_hash, settlement_json, projection_json, refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(root_pin_id) DO UPDATE SET
           title = excluded.title,
           publisher = excluded.publisher,
           task_complete = excluded.task_complete,
           verified = excluded.verified,
           claimed = excluded.claimed,
           open = excluded.open,
           disputed = excluded.disputed,
           total = excluded.total,
           participant_count = excluded.participant_count,
           last_activity_ms = excluded.last_activity_ms,
           boundary_block = excluded.boundary_block,
           event_count = excluded.event_count,
           event_set_hash = excluded.event_set_hash,
           settlement_json = excluded.settlement_json,
           projection_json = excluded.projection_json,
           refreshed_at = excluded.refreshed_at`,
        [
          projection.rootPinId,
          projection.title,
          projection.publisher,
          projection.taskComplete ? 1 : 0,
          projection.progress.verified,
          projection.progress.claimed,
          projection.progress.open,
          projection.progress.disputed,
          projection.progress.total,
          projection.participants.length,
          projection.lastActivityMs,
          projection.freshness.boundaryBlock,
          projection.freshness.eventCount,
          projection.freshness.eventSetHash,
          projection.settlement ? JSON.stringify(projection.settlement) : null,
          JSON.stringify(projection),
          now,
        ]
      );
    }
    // Stale roots (task pins no longer returned by the sweep) drop out.
    const existing = this.getAll<Row>('SELECT root_pin_id FROM metatask_task_projections');
    for (const row of existing) {
      const root = String(row.root_pin_id);
      if (!keep.has(root)) {
        this.db.run('DELETE FROM metatask_task_projections WHERE root_pin_id = ?', [root]);
      }
    }
    this.saveDb();
  }

  getProjection(rootPinId: string): MetaTaskTaskProjection | null {
    const row = this.getOne<Row>('SELECT projection_json FROM metatask_task_projections WHERE root_pin_id = ?', [
      rootPinId,
    ]);
    if (!row?.projection_json) return null;
    try {
      return JSON.parse(String(row.projection_json)) as MetaTaskTaskProjection;
    } catch {
      return null;
    }
  }

  private lastActivityOf(projection: MetaTaskTaskProjection): number {
    let latest = 0;
    for (const node of Object.values(projection.nodeStates)) {
      if (node.holder && node.holder.sinceMs > latest) latest = node.holder.sinceMs;
      if (node.submission && node.submission.atMs > latest) latest = node.submission.atMs;
    }
    return latest;
  }

  board(localRosterMetaIds: string[]): MetaTaskBoard {
    const roster = new Set(localRosterMetaIds.filter(Boolean));
    const rows = this.getAll<Row>(
      `SELECT root_pin_id, projection_json FROM metatask_task_projections
         ORDER BY last_activity_ms DESC, root_pin_id ASC`
    );
    const tasks: MetaTaskBoardTask[] = [];
    const identities: Record<string, MetaTaskIdentity> = {};
    for (const row of rows) {
      try {
        const projection = JSON.parse(String(row.projection_json ?? '{}')) as MetaTaskTaskProjection;
        const myRoles: ('publisher' | 'participant')[] = [];
        if (roster.has(projection.publisher)) myRoles.push('publisher');
        // "Participating" means actual recorded activity — a publisher that
        // only authored the root is not also a participant.
        const mine = projection.participants.filter(
          (participant) =>
            roster.has(participant.metaId) &&
            participant.effectiveClaims + participant.submissions + participant.verifiedContrib + participant.reviewVotes > 0
        );
        if (mine.length > 0) myRoles.push('participant');
        const myStats = mine.length
          ? {
              claimed: mine.reduce((sum, p) => sum + p.effectiveClaims, 0),
              submitted: mine.reduce((sum, p) => sum + p.submissions, 0),
              verified: mine.reduce((sum, p) => sum + p.verifiedContrib, 0),
              reviewVotes: mine.reduce((sum, p) => sum + p.reviewVotes, 0),
              shareBP: projection.settlement
                ? projection.settlement.shares
                    .filter((share) => roster.has(share.metaId))
                    .reduce((sum, share) => sum + share.shareBP, 0)
                : 0,
            }
          : null;
        tasks.push({
          rootPinId: projection.rootPinId,
          title: projection.title,
          brief: projection.brief,
          publisher: projection.publisher,
          tags: projection.tags,
          taskComplete: projection.taskComplete,
          progress: projection.progress,
          participantCount: projection.participants.length,
          lastActivityMs: this.lastActivityOf(projection),
          freshness: {
            boundaryBlock: projection.freshness.boundaryBlock,
            evaluatedAtMs: projection.freshness.evaluatedAtMs,
            eventCount: projection.freshness.eventCount,
          },
          myRoles,
          myStats,
          settlementFinalized: Boolean(projection.settlement),
        });
        Object.assign(identities, projection.identities ?? {});
      } catch {
        // skip malformed rows; the next refresh rewrites them
      }
    }
    return {
      localRosterMetaIds: localRosterMetaIds.filter(Boolean),
      tasks,
      identities,
      alerts: this.listAlerts(),
      activation: { hAct2: H_ACT2 },
      refresh: this.refreshInfo(),
    };
  }

  // ── watch state + alerts (P2 heartbeat) ────────────────────────────────────

  getWatchStatuses(): { root: string; node: string; status: string }[] {
    return this.getAll<Row>('SELECT task_root, node_id, last_status FROM metatask_watch_state').map((row) => ({
      root: String(row.task_root),
      node: String(row.node_id),
      status: String(row.last_status),
    }));
  }

  setWatchStatuses(entries: { root: string; node: string; status: string }[]): void {
    const now = new Date().toISOString();
    for (const entry of entries) {
      this.db.run(
        `INSERT INTO metatask_watch_state (task_root, node_id, last_status, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task_root, node_id) DO UPDATE SET
           last_status = excluded.last_status,
           updated_at = excluded.updated_at`,
        [entry.root, entry.node, entry.status, now]
      );
    }
    this.saveDb();
  }

  appendAlerts(alerts: MetaTaskAlert[]): void {
    for (const alert of alerts) {
      this.db.run(
        'INSERT INTO metatask_alerts (kind, root_pin_id, node_id, detail, created_at_ms) VALUES (?, ?, ?, ?, ?)',
        [alert.kind, alert.rootPinId, alert.node, alert.detail, alert.createdAtMs]
      );
    }
    if (alerts.length > 0) this.saveDb();
  }

  /** Drop alerts older than the horizon so one-shot transition notices decay. */
  pruneAlerts(olderThanMs: number, nowMs: number): void {
    this.db.run('DELETE FROM metatask_alerts WHERE created_at_ms < ?', [nowMs - olderThanMs]);
    this.saveDb();
  }

  listAlerts(limit = 30): MetaTaskAlert[] {
    return this.getAll<Row>(
      'SELECT kind, root_pin_id, node_id, detail, created_at_ms FROM metatask_alerts ORDER BY id DESC LIMIT ?',
      [limit]
    ).map((row) => ({
      kind: String(row.kind) as MetaTaskAlert['kind'],
      rootPinId: String(row.root_pin_id),
      node: row.node_id === null ? null : String(row.node_id),
      detail: row.detail === null ? null : String(row.detail),
      createdAtMs: Number(row.created_at_ms ?? 0),
    }));
  }

  // ── refresh state ──────────────────────────────────────────────────────────

  refreshInfo(): MetaTaskBoard['refresh'] {
    const row = this.getOne<Row>(
      'SELECT last_refresh_at, last_ok_at, last_error, boundary_block, refreshing FROM metatask_refresh_state WHERE id = 1'
    );
    return {
      lastRefreshAtMs: row?.last_refresh_at ? Date.parse(String(row.last_refresh_at)) || null : null,
      lastOkAtMs: row?.last_ok_at ? Date.parse(String(row.last_ok_at)) || null : null,
      lastError: row?.last_error ? String(row.last_error) : null,
      boundaryBlock: row ? Number(row.boundary_block ?? -1) : null,
      refreshing: row ? Number(row.refreshing ?? 0) === 1 : false,
    };
  }

  setRefreshing(refreshing: boolean): void {
    this.db.run('UPDATE metatask_refresh_state SET refreshing = ?, last_refresh_at = ? WHERE id = 1', [
      refreshing ? 1 : 0,
      new Date().toISOString(),
    ]);
    this.saveDb();
  }

  markRefreshDone(ok: boolean, error: string | null, boundaryBlock: number): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE metatask_refresh_state
         SET last_ok_at = CASE WHEN ? = 1 THEN ? ELSE last_ok_at END,
             last_error = ?,
             boundary_block = ?,
             refreshing = 0
         WHERE id = 1`,
      [ok ? 1 : 0, now, error, boundaryBlock]
    );
    this.saveDb();
  }

  bumpSeq(): number {
    this.db.run('UPDATE metatask_refresh_state SET seq = seq + 1 WHERE id = 1');
    this.saveDb();
    const row = this.getOne<Row>('SELECT seq FROM metatask_refresh_state WHERE id = 1');
    return Number(row?.seq ?? 0);
  }
}
